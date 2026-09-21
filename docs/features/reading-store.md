# Local reading store (M6)

## Feature
A local-only, persistent store of `SensorReading`s on `expo-sqlite`, sitting underneath the live
sensor feed, so readings survive an app restart and up to seven days of history stay on the phone
for the Trends screen and the personal baselines that follow.

## Objective
PS §5 (all processing on the device) and PRD §7 (trends over 24 h / 7 d, 7-day resting baselines)
both need history that outlives the process. Before M6 the only reading storage was the feed's
React-state ring buffer: ~20 minutes, gone on kill. Trends rendered a hardcoded constant. This
milestone makes the feed's buffer a *view* over a store that persists, and gives the store a way
to be erased.

## Problem
- Killing the app lost the last 20 minutes of buffered readings; the Dashboard scored nothing
  until Health Connect answered again (`docs/PROJECT_STATUS.md` → Known Risks).
- Nothing older than the engine's longest lookback was ever kept, so multi-day baselines and a
  real Trends screen were impossible (ROADMAP M7, M9+).
- Persisting real vitals raises two obligations the buffer never had: demo data must not
  contaminate history, and the user must be able to erase what is stored.

## Architecture
```
ReadingStoreProvider  (src/store/provider.tsx — mounted in _layout.tsx above SensorProvider)
   │ opens SqliteReadingStore once; falls back to MemoryReadingStore if the open rejects
   ▼
SensorProvider → useSensors({ enabled, store })
   │ warm start: readSince(now − BUFFER_RETAIN_MS) once permissions are confirmed (beginPolling)
   │ each poll:  append(vitals + motion) → prune(now − 7 d) → readSince(now − BUFFER_RETAIN_MS)
   ▼
SensorFeed.readings  (the engine window, served from the store)
SensorFeed.storeFailure  (kind 'store' when the store rejected; buffer fell back to mergeReadings)

Settings → "Erase my health data" → store.clear()
Trends / baselines (M7+) → store.readSince(...) directly — never the feed's buffer
```
The store is the system of record; `mergeReadings` (`src/sensors/ring-buffer.ts`) remains as the
per-poll fallback when the store is unavailable, and its `identity()` is the dedupe key both
backends share. See `docs/architecture/overview.md` for where the sensor layer sits.

## Implementation
[`ADR-006`](../decisions/ADR-006-local-reading-store.md) records the choice: `expo-sqlite`,
plaintext, in app-private storage now; encryption in M12.

- **Contract** (`src/store/types.ts`): `append` (idempotent on identity), `readSince(since,
  until?)` (inclusive both ends, ascending, motion after vitals at a tie), `prune(olderThan)` →
  count, `clear`, `count`. Every method returns copies and rejects with `ReadingStoreError`.
- **SQLite** (`src/store/sqlite.ts`): `openDatabaseAsync('phc.db')`, `PRAGMA journal_mode = WAL`,
  schema v1 via `PRAGMA user_version`. Table `readings(id, key TEXT NOT NULL UNIQUE, ts, source,
  hr, spo2, skin_temp_c, peak_g, min_g, rms_g, sample_count)` + index on `ts`. `INSERT OR IGNORE`
  batched in one `withTransactionAsync`; `readSince` orders `ts, (sample_count IS NOT NULL), id`.
  The unique column is the identity *string*, not a composite over the vitals columns: SQLite
  treats NULLs as distinct inside `UNIQUE`, so a composite over nullable columns would let every
  motion-only reading insert twice. A test pins this.
- **Memory** (`src/store/memory.ts`): the reference implementation and the runtime fallback.
- **Provider** (`src/store/provider.tsx`): `{ store, backend: 'sqlite' | 'memory', ready }`.
  Silent fallback — no `console.*`. `SensorProvider` gates the feed on `ready` so the first poll
  never lands in the pre-open placeholder.
- **Hook** (`src/hooks/use-sensors.ts`): see Data Flow. `HISTORY_RETAIN_MS` (7 days) is exported
  from `src/store/types.ts`.
- **Settings** (`src/app/settings.tsx`): the "Erase my health data" row, Data sharing card,
  destructive style, confirm `Alert`, copy "Deletes all readings stored on this phone. Settings
  and contacts are kept."

Not persisted: raw `motion` vectors (no adapter emits them; the fold produces summaries). A reading
carrying only a raw vector is dropped by `append`.

## Files
- `src/store/types.ts`, `src/store/reading.ts`, `src/store/memory.ts`, `src/store/sqlite.ts`,
  `src/store/provider.tsx`, `src/store/index.ts`
- `src/hooks/use-sensors.ts` (store wiring), `src/sensors/provider.tsx` (ready gate),
  `src/sensors/types.ts` (`storeFailure`, `SensorFailureKind` `'store'`),
  `src/sensors/ring-buffer.ts` (`identity` exported)
- `src/app/_layout.tsx` (provider mount), `src/app/settings.tsx` (erase row)
- `jest/setup-after-env.js` (inert `expo-sqlite` shim), `app.json` (config plugin), `package.json`

## Data Flow
1. `useSensors` polls Health Connect (vitals) and flushes the accelerometer fold (motion summary)
   exactly as before.
2. The poll `append`s both to the store — the motion-only reading of a failed vitals read too, so
   the fall rule's trail survives a flaky band and a restart.
3. `prune(now − 7 d)`, then `readSince(now − BUFFER_RETAIN_MS)` becomes the feed's buffer.
4. Once Health Connect permissions are confirmed (`beginPolling` — the same point the
   accelerometer fold starts), before the first poll, the buffer is warm-started from the store.
   Not on bare enable: while status is `permission-required` the Dashboard's notice assumes an
   empty buffer, and painting a previous session's readings there would mislead.
5. **Nothing leaves the device.** The store is a file in the app's private directory; no code path
   reads it for transmission. The SOS payload (PRD §7.2.6) is composed from the feed's latest
   vitals, as before, not from the store.
6. **Simulated readings are never written.** The store is touched only from the poll and the
   warm start, both unreachable while `enabled` is false (simulated source). The dev "Simulate a
   fall" splice happens in the Dashboard, downstream of the feed. Pinned by
   `use-sensors.test.ts` ("never writes to the store while disabled").

## Tests
Unit / integration, Jest + RNTL, `expo-sqlite` inert under the global shim:
- `src/store/__tests__/store-contract.ts` — the shared contract (dedupe, ordering incl.
  motion-last at ties, inclusive bounds, prune count, clear, copies), run against **both**
  backends.
- `src/store/__tests__/memory.test.ts` — contract + identity parity with the ring buffer.
- `src/store/__tests__/sqlite.test.ts` + `fake-database.ts` — contract over a fake
  `SQLiteDatabase` that recognises the store's SQL *by exact text*: migration on a fresh file and
  skip on a current one, refusal of a newer schema, one transaction per batch with rollback, NULL
  binding, the `key` UNIQUE guard, and `ReadingStoreError` on every operation.
- `src/store/__tests__/provider.test.tsx` — sqlite when it opens, memory fallback (silent),
  throws outside the provider, injected store, post-unmount safety.
- `src/hooks/__tests__/use-sensors.test.ts` — warm start, append→prune→readSince order and
  arguments, 7-day prune cutoff, zero writes while disabled (interval, foreground, refresh,
  requestAccess, disable cleanup), store-failure fallback with `storeFailure` set and cleared.
- `src/sensors/__tests__/provider.test.tsx` — feed waits for `ready`.
- `src/__tests__/settings-screen.test.tsx` — erase row copy, confirm-before-erase, cancel keeps
  data, confirm clears the store and leaves settings/contacts intact, failure copy.

## Device Validation
**No.** This feature has not run on a device. What the fake cannot prove and a device run must:
- `openDatabaseAsync('phc.db')` succeeds in the EAS dev client and the file persists across a
  force-stop (Settings → Apps → Force stop, relaunch → Dashboard shows the previous readings
  before the first poll completes).
- `PRAGMA journal_mode = WAL` and `PRAGMA user_version` behave as documented on the bundled
  SQLite.
- `INSERT OR IGNORE` on the `key` UNIQUE column really drops a re-polled sample (count stays
  flat across two polls over the same Health Connect range).
- `ORDER BY ts, (sample_count IS NOT NULL), id` returns the motion reading last at the poll
  instant (the Dashboard's fall rule still fires on the dev splice after a restart).
- "Erase my health data" empties the file and the next poll re-fills only the current window.
Add these to `docs/validation/device-validation-plan.md` on the next device run.

## Known Limitations
- **Plaintext.** The database is readable by anything with access to the app sandbox (root, ADB
  backup). Encryption is M12 (ADR-006).
- A memory fallback is silent by design: the app runs exactly as it did before M6, but the user is
  not told that history is not being kept. `backend` is exposed for a later Settings line.
- `withTransactionAsync` (not the exclusive variant): the store's own calls are sequential within
  a poll, and `clear()` from Settings during an append would simply commit with it. Revisit if a
  second writer appears (M8 background service).
- The hook's warm start reads only the engine window; it does not verify the store's contents
  against Health Connect. Erasing while live means the next poll re-reads the last ~20 min from
  Health Connect and re-persists them — Health Connect is the phone's source of truth for those.
- `expo-sqlite` on web is not exercised; the provider's fallback covers it.
- Raw motion vectors are not stored (see Implementation).

## Security
No new permission. Read/write to one file (`phc.db`, plus WAL sidecars) in the app-private
database directory. No network. The config plugin `expo-sqlite` was added to `app.json` by
`expo install`; it enables no extra native capability.

## Privacy
Stores HR, SpO₂, skin temperature, and per-minute motion summaries (peak/min/rms/count) with
timestamps and source, for up to seven days, on the phone only, unencrypted until M12. Never
transmitted. Erasable by the user from Settings. Demo data is never written. See
[`docs/security/privacy-architecture.md`](../security/privacy-architecture.md).

## Future Improvements
- M7 Real Trends: read 24 h / 7 d aggregates from `store.readSince`; delete the `TRENDS` constant.
- M9+: 7-day baselines (resting HR, SpO₂) from the store.
- M12: encrypt the database (key in Android Keystore); revisit whether `expo-sqlite`'s SQLCipher
  build or a different driver is the path.
- Surface `backend === 'memory'` and `storeFailure` in Settings / the Dashboard notice so a user
  knows when history is not being kept.
- Schema v2 candidates: a `session` column for restart boundaries; a per-day rollup table if
  Trends queries prove slow at 7 × 1440 rows per vital.

## Status
Built · Unit tested · Integration tested (screen-level, memory backend) — **not device validated**.
The SQL layer is tested against a fake driver; the real `expo-sqlite` driver has not been run.
