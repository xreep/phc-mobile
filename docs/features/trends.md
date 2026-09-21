# Real Trends from the reading store (M7)

## Feature
The Trends screen reads real 24-hour / 7-day vitals history from the persisted reading store
(M6) and shows min/avg/max plus a bucketed sparkline per vital, with honest empty states when
there is nothing to show. The hardcoded `TRENDS` constant and its "Example data" disclosure
banner are gone.

## Objective
PS §7a asks for "daily summaries and trend analysis." PRD §7.2.4's Trends screen shipped first as
a concept demo (`docs/features/reading-store.md`'s Future Improvements named this milestone) —
fixed sample curves with a banner explaining they were not real. M6 gave the app somewhere to
read real history from; this milestone is the screen actually reading it.

## Problem
- The screen rendered `constants/health-data.ts`'s `TRENDS` constant regardless of what the user's
  phone had actually recorded — a chart that never changes and cannot mislead only because it
  says so on screen.
- A real chart needs to say three different true things depending on state: "you're on the demo
  source, there's nothing to read" (simulated), "you're on a live source but nothing has synced
  yet" (empty), and "this phone's history may not survive a restart" (SQLite failed to open,
  `store/provider.tsx`'s silent memory fallback) — three states the constant could never
  represent because it never had any state.

## Architecture
```
useTrends(range)                              (src/hooks/use-trends.ts)
   │ useReadingStore().store.readSince(now − rangeMs, now)
   │ useSensorFeed().lastPolledAt   — re-read on every completed poll
   │ useSettings().settings.sensorSource + backend — the 'unavailable' rule only
   ▼
summarizeTrend(readings, field, {from, to, buckets})   (src/trends/aggregate.ts, pure)
   │ re-applies the plausibility gate (DEFAULT_RISK_THRESHOLDS.plausible) readings pass through
   │ before being charted — collectSamples itself is not on @/risk's public surface
   ▼
TrendSummary[] (hr, spo2, skinTempC)  →  src/app/trends.tsx  →  MiniBars (null = gap, not zero)
```
`dailySummary` lives in the same module (per-vital min/avg/max over one day plus
`elevatedMinutes`, PRD §7.2.2's flag lines) but nothing in this milestone's UI calls it yet — it
is aggregation the store now makes possible, tested standalone, for a daily-summary surface a
later milestone wires up.

## Implementation
- **`src/trends/aggregate.ts`** (pure, no React, no clock): `summarizeTrend` buckets an inclusive
  `[from, to]` span into `buckets` equal slices, means each bucket, and returns `null` for an
  empty one rather than `0` — a `0`-height bar on a heart-rate chart reads as "measured zero",
  which is a false and alarming claim a gap does not make. Returns `null` overall when nothing
  plausible falls in range. `dailySummary` does the same per-vital summarizing over one day plus
  `elevatedMinutes` — minutes holding a reading with `hr > heartRate.tachycardiaAbove` or
  `spo2 < spo2.flagBelow`, both read from `DEFAULT_RISK_THRESHOLDS`, never restated as literals.
- **The plausibility gate is re-derived, not imported.** `src/risk/window.ts`'s `collectSamples`
  does the identical filtering, but only `VitalField` (a type) is on `@/risk`'s public surface —
  the barrel's own header describes the engine's app-coupling as exactly four *types*. Reaching
  past it into `@/risk/window` for a value-level import would be the same kind of undocumented
  coupling in the other direction, so `aggregate.ts` re-implements the one-line check
  (`Number.isFinite` + inside `DEFAULT_RISK_THRESHOLDS.plausible[field]`) instead.
- **`src/hooks/use-trends.ts`**: same discipline as `use-environment.ts` / `use-sensors.ts` — a
  `mounted` ref guards `setState` after an `await`. `status` is `'loading' | 'ready' | 'empty' |
  'unavailable'`; `'unavailable'` fires from `backend === 'memory' && sensorSource ===
  'health_connect'` alone, independent of whether a read has resolved — a memory backend only
  exists at runtime when SQLite failed to open, so this is a warning about *history not
  surviving a restart*, not about there being no data right now. There is deliberately no
  `'simulated'` status: whether the current picker is on simulated data is a display decision
  (always show the "switch source" banner, never the chart), not a data one, so it is
  `src/app/trends.tsx` that special-cases `settings.sensorSource === 'simulated'`, not the hook.
- **`src/components/mini-bars.tsx`**: `points` widened from `number[]` to `(number | null)[]`; a
  `null` renders an empty slot (no bar), not a zero-height one.
- **`src/app/trends.tsx`**: same range toggle and `Stat`/card layout as the sample-data version;
  now driven by `useTrends`. Four render branches ahead of the chart: simulated source (always,
  regardless of leftover store data), `unavailable`, `loading`, `empty`, and — a footer line
  "Stored on this phone only · last N days" from `HISTORY_RETAIN_MS`, shown in every state, since
  it is a true statement about the store independent of what is currently selected.
- **`src/constants/health-data.ts`**: `TRENDS` and `TrendSeries` deleted. `TrendRange` kept — it
  is the one shape the range toggle and `useTrends` still share.

## Files
- `src/trends/aggregate.ts`, `src/trends/__tests__/aggregate.test.ts`
- `src/hooks/use-trends.ts`, `src/hooks/__tests__/use-trends.test.ts`
- `src/components/mini-bars.tsx`, `src/components/__tests__/mini-bars.test.tsx`
- `src/app/trends.tsx`, `src/__tests__/trends-screen.test.tsx`
- `src/constants/health-data.ts` (`TRENDS`/`TrendSeries` removed, `TrendRange` kept)

## Data Flow
1. `useTrends(range)` reads `store.readSince(now − rangeMs, now)` on mount, on every `range`
   change, and on every `lastPolledAt` change (a poll just persisted something new).
2. `summarizeTrend` runs once per vital (hr, spo2, skinTempC, in that order) over the same
   reading list; a vital with zero plausible samples in range is dropped from `series` entirely
   rather than rendered as an empty card.
3. Nothing here reaches the network. `readSince` is the same local-only store M6 documents; the
   screen only ever displays what is already on the phone.

## Tests
Unit / integration, Jest + RNTL:
- `src/trends/__tests__/aggregate.test.ts` — bucket boundaries (a reading exactly at `from`/`to`),
  null buckets, plausibility rejection, `current` = newest (not last-appended), avg precision,
  multi-sample bucket means, `dailySummary`'s `elevatedMinutes` against the config thresholds
  (not literals) including the strict-inequality boundary.
- `src/hooks/__tests__/use-trends.test.ts` — `loading` → `ready`, `empty`, the `unavailable` rule
  fired from `backend`/`sensorSource` alone (including that it does *not* fire on `ble_esp32` or
  on a `sqlite` backend), re-read on `lastPolledAt` change and on range change, no `setState`
  after unmount. `useReadingStore`/`useSensorFeed`/`useSettings` are mocked directly so `backend`
  can be set to `'sqlite'` in a test — a real device only reports `'memory'` when SQLite failed to
  open, which this suite does not need to fake to exercise the rule.
- `src/components/__tests__/mini-bars.test.tsx` — a `null` point renders an empty slot, not a bar.
- `src/__tests__/trends-screen.test.tsx` — simulated source shows the disclosure and no chart
  *even when the store holds real history* (leftover from an earlier Health Connect session); a
  live, non-Health-Connect source (`ble_esp32`, chosen so `'unavailable'` is not also in play)
  with a seeded `MemoryReadingStore` renders numbers chosen so they exist nowhere in source
  (133/61/200/131 bpm — current, min, max, avg); the empty state when nothing is in range; the
  range toggle re-aggregating (a reading placed only inside the 7-day window is invisible at 24h
  and appears at 7d).

## Device Validation
**No.** A fresh EAS build is needed to test on-device, but only because M6's PR added the
`expo-sqlite` config plugin — this milestone adds no native dependency of its own and changes no
native configuration. What a device run should confirm:
- The Trends screen, with Health Connect selected and history from a prior session, shows
  numbers and a sparkline that look like what the Dashboard's own vitals row has been showing.
- Toggling 24h/7d on a real store with more than a day of history re-renders promptly (no
  noticeable read latency from SQLite at this row count).
- The `'unavailable'` notice actually appears on a device where SQLite failed to open (currently
  unobserved — every device run so far has SQLite opening successfully per
  `docs/features/reading-store.md`'s own Device Validation section).

## Known Limitations
- `dailySummary` is implemented and unit-tested but has no caller yet — no screen surfaces a
  daily rollup. It exists because the store now makes it possible and a later milestone needs the
  same plausibility-gated aggregation this one already built and tested.
- The `'unavailable'` notice is worded as a general "may not survive a restart" statement; it does
  not (and cannot, from the hook's inputs alone) say *why* SQLite failed to open.
- No caching or memoization beyond React state: switching ranges re-reads and re-aggregates from
  scratch every time. At the store's current row counts (up to 7 days × per-minute samples) this
  is unmeasured but expected to be fast; revisit if `docs/features/reading-store.md`'s own
  "per-day rollup table" idea becomes necessary.
- Bucket boundaries use `Math.floor` with the last bucket absorbing anything exactly at `to`; this
  is documented and tested but is a choice among a few reasonable ones (a half-open `[from, to)`
  scheme would instead have needed a `buckets + 1`-th slot for the boundary instant).

## Security
No new permission, no new native dependency, no network call. Reads only from the existing
on-device `ReadingStore` (`docs/features/reading-store.md`'s Security section covers that file).

## Privacy
Displays HR, SpO₂, and skin temperature history already stored on the phone (M6); nothing new is
collected, and nothing here transmits anything. See
[`docs/security/privacy-architecture.md`](../security/privacy-architecture.md).

## Future Improvements
- Wire `dailySummary` into a daily-rollup surface (a calendar view, or a "today" card) once one is
  designed.
- Surface *why* the backend fell back to memory (the underlying `expo-sqlite` open error) rather
  than only that it did.
- M9+: the 7-day baselines milestone can likely share `aggregate.ts`'s plausibility gate rather
  than re-deriving a third copy of it — worth revisiting once `@/risk`'s public surface is
  reconsidered.

## Status
Built · Unit tested · Integration tested (screen-level, memory backend) — **not device
validated**.

---

## Proposed status-doc updates

The controller owns `docs/PROJECT_STATUS.md`, `docs/BUILD_MATRIX.md`, `docs/JUDGE_QA.md`,
`docs/ROADMAP.md`, and `CHANGELOG.md`; the entries below are proposed for those files, not
applied here.

### CHANGELOG fragment

```
### Added
- Trends screen: 24 h / 7 d min/avg/max and a sparkline computed from the persisted reading
  store (`src/trends/aggregate.ts`, `src/hooks/use-trends.ts`), replacing the hardcoded `TRENDS`
  constant. Honest empty states for the simulated source, no data yet, and a memory-backend
  fallback. See `docs/features/trends.md`.

### Removed
- `TRENDS`, `TrendSeries`, and the Trends screen's "Example data" sample banner
  (`constants/health-data.ts`, `app/trends.tsx`) — superseded by real store-backed history.
```

### BUILD_MATRIX row

Replaces the existing `Trends screen` row (`🟡 | ✅ | ❌ | ❌ | Mock-demo — renders hardcoded
TRENDS constants`):

| Feature | Implemented | Tested | Device Validated | Real-World Validated | Status |
| --- | --- | --- | --- | --- | --- |
| Trends screen | ✅ | ✅ | ❌ | ❌ | Integration tested — real 24h/7d history from the reading store, not device validated |

### ROADMAP M7 fragment

Under `### M7 — Real Trends`:

```
**Status: implemented, awaiting device validation.** `src/trends/aggregate.ts` +
`src/hooks/use-trends.ts` replace the `TRENDS` constant with real `store.readSince` aggregates —
see `docs/features/trends.md`. Both gates are met by tests: an empty state renders when no
history exists (simulated source and empty-store cases, `trends-screen.test.tsx`), and rendered
values match hand-computed aggregates on a seeded store (133/61/200/131 bpm — current/min/max/avg
— in the same suite).
```
