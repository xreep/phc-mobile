# Live sensor ingestion from Android Health Connect — design

**Date:** 2026-09-15
**PRD:** §7.2.1 (sensor ingestion), §6.4 (Health Connect), §11 (live-data success metric)
**Status:** approved

## Goal

Replace the Dashboard's synthesised sensor window (`buildMockReadings`) with a live
`SensorReading[]` ring buffer fed by Android Health Connect (HR, SpO₂, skin temperature)
and the phone accelerometer (folded into `MotionSummary`), gated by the existing
Settings "Sensor source" picker so the simulated window remains available as a demo
fallback.

Out of scope: Trends screen, TFLite, ESP32/BLE, iOS/HealthKit.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Source gating | `settings.sensorSource === 'health_connect'` enables the live feed; `'simulated'` (the default) keeps the mock window | PRD §12 risk: Health Connect may have no data on a judge's device. The picker already exists and nothing reads it. |
| Poll cadence | 60 s | The engine's thresholds and tests are tuned at this cadence (`mock-sensor-window.ts` documents the boundary). |
| Skin temperature | Only emitted when the HC record carries a `baseline`; `skinTempC = baseline + delta`. No baseline → no reading. `BodyTemperature` is not read. | HC `SkinTemperature` is a delta series. A bare delta is not a temperature; `types.ts` forbids conflating skin and core temp. No rule reads `skinTempC`, so omission is safe. |
| Missing vitals | Left `undefined`, never `0` | `types.ts` contract — `spo2: 0` reads as catastrophic hypoxia. |
| Motion-only readings | A reading at `timestamp: now` carrying only `motionSummary` is emitted every tick even if HC produced nothing | Otherwise fall and heat-stillness rules never see the accelerometer while the band is quiet. |
| Permission prompts | Only from user-initiated `requestAccess()`; the interval and AppState paths never prompt | Same discipline as `use-environment.ts` — an unbidden dialog is how a permission gets permanently denied. |
| Buffer length | `longestLookbackMs(thresholds) + 2 × POLL_INTERVAL_MS`, read from `resolveRiskThresholds()` via a new export in `risk/assess.ts` | Not hardcoded; `RiskAssessmentInput` doc requires the buffer to span the engine's longest lookback. |
| simulateFall | Kept, dev-only. In live mode the same `FALL_IMPACT` + stillness tail is spliced onto the live buffer. | Proves the detector on real data during the demo without a physical fall. |
| Engine still-run primitives | `longestStillRunMs` / `trailingStillRunMs` skip readings with no motion data instead of breaking on them; `maxGapMs` is measured between motion-bearing readings. | Probed: with HR samples interleaved between per-minute motion readings (the live shape) every still run was zero, so `fall.impactThenStillness` and `heat.stillness.critical` were unsatisfiable on real hardware. Dropouts still break the run via the gap check. Approved 2026-09-15. |

## Modules

```
src/sensors/
  types.ts           SensorFeed, SensorFeedStatus, SensorFailure
  health-connect.ts  ensureHealthConnect(), requestVitalsAccess(), readVitals(); pure mappers
  motion.ts          startMotionFold(): { flush(): MotionSummary | null; stop(): void }
  ring-buffer.ts     mergeReadings(buffer, incoming, { now, retainMs }) — pure
  provider.tsx       SensorProvider + useSensorFeed() (throws when unmounted)
  index.ts
src/hooks/use-sensors.ts
```

### health-connect.ts

- `getSdkStatus()` ≠ available → `'unavailable'`; nothing polls.
- `initialize()` then `getGrantedPermissions()`; read whatever is granted.
- `readVitals({ sinceMs, untilMs, signal })` → `SensorReading[]`:
  - `HeartRate`: one reading per `samples[i]` → `{ source: 'health_connect', timestamp: Date.parse(time), hr: beatsPerMinute }`.
  - `OxygenSaturation`: one reading per record → `{ …, spo2: percentage }`.
  - `SkinTemperature`: with `baseline`, one reading per delta → `{ …, skinTempC: baseline.inCelsius + delta.inCelsius }`; without, none.
- First poll reads `now − longestLookbackMs`; later polls read `lastPolledAt → now`.
- Pure mappers `mapHeartRate`, `mapOxygenSaturation`, `mapSkinTemperature` are exported for tests.

### motion.ts

- `Accelerometer.setUpdateInterval(40)` (~25 Hz). Each sample's magnitude `√(x²+y²+z²)` in g (expo-sensors reports g with gravity; rest ≈ 1.0).
- Accumulates peak, min, sum of squares, count. `flush()` returns `{ peakG, minG, rmsG, sampleCount }` and resets; returns `null` when `sampleCount === 0`.
- `stop()` removes the subscription.

### ring-buffer.ts

- Merge incoming into buffer, dedupe on `(timestamp, source, vital-field-set)`, sort ascending, drop readings older than `now − retainMs`.

### use-sensors.ts

- `useSensors({ enabled }): SensorFeed`
  - `enabled === false` → `{ status: 'idle', readings: [] }`, no native calls.
  - Status: `'idle' | 'unavailable' | 'permission-required' | 'loading' | 'live' | 'error'`.
  - On mount (enabled): ensure SDK → granted perms → if none, `'permission-required'`; else start motion fold, poll immediately, then every 60 s.
  - Each tick: `readVitals` + `motionFold.flush()` → motion reading at `now` → `mergeReadings`.
  - AppState → `'active'`: poll now if `now − lastPolledAt >= POLL_INTERVAL_MS`.
  - `mounted` ref + generation counter guard every `setState` after an await; unmount stops the fold and cancels in-flight work.
  - Read errors: status `'error'`, buffer kept (readings age out; engine reports `stale`).
  - `requestAccess()`: user-initiated; calls `requestPermission()`; on any grant → start polling.

### provider.tsx

- `SensorProvider` mounts inside `SettingsProvider`; passes `enabled = sensorSource === 'health_connect'`.
- `useSensorFeed()` throws outside a provider.

### use-risk-assessment.ts

```
const live = sensorSource === 'health_connect';
const readings = live
  ? spliceSimulatedFall(feed.readings, now, simulateFall)
  : buildMockReadings(now, { simulateFall });
```

`DashboardRisk` gains `feedStatus`, `source`, and `requestAccess`. `FALL_IMPACT` stays in
`mock-sensor-window.ts`; the splice helper is extracted so both paths share it.

### Dashboard

One hint row driven by `feedStatus`: `'permission-required'` (tap → `requestAccess`),
`'unavailable'`, and `'loading'` / empty buffer ("Waiting for Health Connect…"). No other UI change.

## Native config

- Deps: `react-native-health-connect@4.1.3`, `expo-sensors@~57.0.3`, `expo-dev-client@~57.0.19`, dev: `expo-build-properties@~57.0.17`.
- `app.json`: plugins `react-native-health-connect` and `expo-build-properties` (`minSdkVersion: 26`); `android.permissions`: `android.permission.health.READ_HEART_RATE`, `READ_OXYGEN_SATURATION`, `READ_SKIN_TEMPERATURE`.
- v4 registers the permission delegate through its bundled Expo module — no `MainActivity` edit. `android/` is gitignored; regenerate with `npx expo prebuild --platform android`.

## Testing

- Global inert mocks for `react-native-health-connect` and `expo-sensors` in `jest/setup-after-env.js`; per-test overrides.
- `sensors/__tests__/health-connect.test.ts`: mappers (HR samples fan-out, SpO₂, skin temp with/without baseline — never 0), `readVitals` range and granted-permission filtering, unavailable SDK.
- `sensors/__tests__/motion.test.ts`: rest ≈ 1.0 g, impact peak/min, empty flush → null, reset after flush, unsubscribe on stop.
- `sensors/__tests__/ring-buffer.test.ts`: dedupe, sort, trim at the boundary, retention ≥ `longestLookbackMs`.
- `hooks/__tests__/use-sensors.test.ts`: disabled = zero native calls; warm-up range; interval; AppState boundary both sides; interval never prompts; `requestAccess` prompts; no setState after unmount.
- `sensors/__tests__/provider.test.tsx`: throws without provider.
- Existing screen tests get `SensorProvider` in their wrapper. Baseline 985 must stay green after every step.
