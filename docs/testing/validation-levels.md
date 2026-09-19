# Validation levels

Six levels, static correctness through failure-path behaviour. This ladder is finer-grained than the
Built/Unit tested/.../Real-world validated ladder used elsewhere in this repo's docs (which is about
*feature* maturity); this one is about *how thoroughly* a given piece of code has been exercised.
Most of this codebase sits at Level 2–3 today; nothing has reached Level 4 or beyond.

## The six levels

### Level 1 — Static
Type-checking and linting; no code executes. Catches shape errors, unused code, and the project's
lint rules before anything runs.
```
npx tsc --noEmit
npx eslint src --max-warnings 0
git diff --check
```

### Level 2 — Unit
Pure functions and isolated modules exercised in Jest, with native modules (`react-native-health-connect`,
`expo-sensors`, `expo-location`, AsyncStorage) mocked. This is where the rule engine's ~600 tests, the
sensor mappers, and the SOS state machine live.
```
npm test
```

### Level 3 — Integration
Multiple modules composed together in Jest + React Native Testing Library — a screen rendered with
real providers (`SettingsProvider`, `EnvironmentProvider`, `SensorProvider`) and seeded state, still
against mocked native modules. Screen tests (`src/__tests__/`) and hook tests
(`hooks/__tests__/use-sensors.test.ts`) live here, in the same `npm test` run as Level 2 — the
distinction is what a given test file composes, not a separate command.
```
npm test
```

### Level 4 — Device
The app running on a real or emulated Android device, against the real Health Connect SDK, the real
accelerometer, and real OS permission dialogs. Requires a development-client build; Expo Go cannot
run this app because Health Connect is a native module.
```
npx expo prebuild --platform android
eas build --profile development --platform android
```
**Reached by:** UI rendering and live OpenWeatherMap weather, on the August APK, against a simulated
vitals window. **Not yet reached** by Health Connect ingestion, the accelerometer fold, fall
detection, or any part of the SOS delivery path (relay or composer).

### Level 5 — Real-world
Use by a real person, in real conditions, outside the development team — a multi-day wear test, a
second phone receiving an SOS SMS, an actual heat/pollution event. **Not reached by anything in this
repository.**

### Level 6 — Failure
Deliberately exercising failure paths: network down, permission denied then retried, a relay
returning 5xx, Health Connect throwing on `SkinTemperature`, airplane mode, clock skew between a band
and the phone, an app killed mid-poll. Partially covered at Level 2–3 today (e.g. `use-environment.ts`
cache-on-failure tests, `sos/deliver.ts` fallback-on-non-2xx tests) but never run at Level 4 or 5 — no
failure path has been exercised on a real device or in a real network-degraded environment.

## What each feature has reached today

| Feature | Level reached | Notes |
| --- | --- | --- |
| Rule engine (`src/risk/`) | 2 | ~600 tests, cadence-aware, includes some Level-6-style failure/edge cases (missing data, stale readings) but only in Jest |
| Environment module | 2–3 | Fetch/cache/failure unit tested; screen integration tested; live weather reached Level 4 on the August APK |
| Health Connect ingestion | 2–3 | Mapper and hook tests, screen integration; never Level 4 — no test has touched a real Health Connect SDK |
| Accelerometer fold | 2 | Unit tested against a mocked `expo-sensors`; never run against real accelerometer data |
| SOS flow | 2–3 | State machine, message, delivery, and screen-level tests; relay and composer never exercised at Level 4 |
| Settings persistence | 2 | Store round-trip tested against mocked AsyncStorage |
| Community / Trends | 2–3 | Screen-level tests against static/demo data; not applicable beyond that, since there is no live data path yet |

No feature in this repository has reached Level 5. Level 4 has been reached only for UI rendering and
live weather, and only against a simulated vitals window — see
[`docs/PROJECT_STATUS.md`](../PROJECT_STATUS.md) for the feature-by-feature ladder and
[`docs/validation/device-validation-plan.md`](../validation/device-validation-plan.md) for the
protocol to reach Level 4 for the sensing and SOS paths.
