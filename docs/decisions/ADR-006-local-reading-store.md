# ADR-006: A local reading store on expo-sqlite, plaintext now, encrypted in M12

## Status

Accepted — implemented in workstream B1 (M6). **Device validated: NO.** See
[`docs/features/reading-store.md`](../features/reading-store.md).

## Context

PS §5 requires all health-data processing to stay on the device; PS §7 / PRD §7.2.2 ask for
trends over 24 h and 7 d and for personal baselines computed over the past seven days. Until M6
the app held readings only in the live feed's React-state ring buffer, sized to the risk engine's
longest lookback (~20 minutes): a force-stop lost everything, nothing older was ever kept, and the
Trends screen rendered a hardcoded constant (`docs/PROJECT_STATUS.md` → Known Risks, "No
persistence").

The PRD names SQLCipher as the storage target. `CLAUDE.md` records that stack decision. But an
encrypted store is not one decision, it is three — a persistence layer, a key-management story
(where the key lives, how it survives reinstall, what happens on a device without a hardware
keystore), and an encrypted driver build — and the second and third are not on M6's critical path
while the first blocks M7 (Trends) and M9+ (baselines) outright.

Two constraints came with persisting real vitals for the first time:
- The default sensor source is a simulated window, and a dev control splices a synthetic fall onto
  the live buffer. Neither may ever reach stored history.
- Anything that persists health data must be erasable by the user.

## Options considered

1. **Keep readings in React state** (status quo). Rejected: does not survive a restart; cannot hold
   seven days; blocks M7 and the baselines.
2. **An AsyncStorage JSON blob** of the reading array. Rejected: the app already stores settings
   this way, so it is the smallest change — but seven days of readings is on the order of 10⁴
   rows per vital, and a blob has to be read, parsed, deduped, and rewritten whole on every
   60-second poll. No range queries, no partial prune, no transaction. It would work for a demo
   and fall over the moment Trends asked for a 7-day aggregate.
3. **`expo-sqlite` (SDK 57), plaintext, in app-private storage — chosen.** Range queries and
   prunes are indexed; a batch is one transaction; `PRAGMA user_version` gives migrations; WAL
   makes the per-minute write cheap. The file lives in the app's private directory: other apps
   cannot read it without root; it is deleted with the app. Encryption is deferred, not dropped.
4. **SQLCipher now** (`expo-sqlite` with `useSQLCipher`, or `react-native-quick-sqlite` /
   `op-sqlite` with a SQLCipher build). Rejected *for M6*: it forces the key-management decision
   (Android Keystore-wrapped key, biometric gate or not, behaviour on reinstall / backup) into a
   milestone whose gate is "readings survive a restart", and it has not been device-validated in
   this project at all — a wrong turn there would sit under every later milestone. It stays the
   target for M12.

## Decision

- Add `expo-sqlite ~57.0.3`. One database, `phc.db`, opened with `openDatabaseAsync` in the
  default (app-private) directory, WAL journal mode, schema versioned by `PRAGMA user_version`.
- One `ReadingStore` contract (`src/store/types.ts`) with two implementations: SQLite for the
  app, memory for tests and as the runtime fallback when the open rejects. A shared contract
  suite keeps them identical in behaviour.
- Dedupe on the ring buffer's `identity()` string stored in a `key TEXT NOT NULL UNIQUE` column,
  **not** on a composite `UNIQUE` over the vitals columns: SQLite treats NULLs as distinct inside
  `UNIQUE`, so a composite over nullable columns would never dedupe a motion-only reading.
- The live feed makes the store its system of record: append → prune to seven days → read the
  engine window back. A store failure degrades to the in-memory merge for that poll and is
  reported separately (`storeFailure`), never as a feed failure.
- The store is written **only** while the feed is polling Health Connect. Simulated readings and
  the dev fall splice never reach it. This is the hook's guarantee, pinned by tests, because the
  store cannot tell a demo reading from a real one.
- An **"Erase my health data"** control ships in the same milestone as the store, in Settings →
  Data sharing, behind a confirm. It clears the reading store and nothing else.
- Encryption (key in the Android Keystore) is **M12**. Until then the store is documented as
  plaintext in `docs/security/privacy-architecture.md` and the feature doc.

## Consequences

- Positive: readings survive a restart; the Dashboard warm-starts from the previous session
  instead of showing "waiting" until Health Connect answers; M7 (Trends) and the baselines have
  a queryable seven-day history to read.
- Positive: the memory fallback means a device where SQLite fails to open behaves exactly as the
  app did before M6 — never worse.
- Negative / obligation: real vitals now persist on the phone in plaintext. The erase control is
  therefore mandatory, not optional, and the privacy doc must say plainly that readings are
  stored and unencrypted until M12. Anyone with sandbox access (root, ADB backup) can read them.
- Negative: the fallback is silent. A user on a memory backend is not told history is not being
  kept; `backend` is exposed so a later Settings line can say so.
- Negative: the real driver is untested until a device run. The SQL layer is exercised against a
  fake that pins the statements by text; whether the bundled SQLite honours them identically is
  the first item on the next device-validation list.
- Follow-up decisions this ADR does not make: the M12 key-management design; whether background
  sensing (M8) writes through the same store from a foreground service (it should — one writer —
  but that needs the exclusive-transaction question revisited); the Trends query shape.
