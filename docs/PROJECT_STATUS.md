# Project status

**Current Version:** 0.2.0 — see [`CHANGELOG.md`](../CHANGELOG.md).

This document is a snapshot derived from [`docs/prototype-audit-2026-09-19.md`](prototype-audit-2026-09-19.md)
(the audit this documentation tree implements) and the code in `src/`. It uses the validation
ladder consistently: **Built → Unit tested → Integration tested → Device validated → Real-world
validated**, or **Mock-demo / Planned / Blocked** where the ladder does not apply. No accuracy,
false-positive, or battery figure is stated anywhere in this repo — none has been measured.

---

## Implemented

Genuinely built, unit- and/or integration-tested, on-device behaviour not yet confirmed:

- **App shell** — 5-tab Expo Router app (Dashboard, Trends, Environment, Community, Settings), theming, splash. *Unit/integration tested.*
- **Tier-1 rule engine** (`src/risk/`) — 6 deterministic categories (heat, respiratory, cardiovascular, fall, dehydration, fatigue). Pure, clock-free, ~600 tests. *Unit tested.*
- **Environment module** (`src/environment/`) — coarse-location weather + AQI via OpenWeatherMap, offline cache with staleness bound. *Unit/integration tested; live weather seen working on the August APK.*
- **Health Connect ingestion** (`src/sensors/`, `hooks/use-sensors.ts`) — HR/SpO₂/skin-temp polling every 60 s, accelerometer fold into `MotionSummary`, ring buffer. *Unit tested against mocked native modules only — never run against real Health Connect or a real accelerometer.*
- **Emergency SOS** (`src/sos/`) — state machine, 30 s cancel window, Twilio relay + native SMS composer fallback. *Unit/integration tested. Relay not deployed.*
- **Settings persistence** (`src/settings/`) — contacts, name, sharing prefs, sensor source, in plaintext AsyncStorage. *Unit tested.*
- **Preparedness advisories** (`src/advisories/`) — static flood/cyclone guidance, explicitly unattributed. *Unit tested.*

## Partially Implemented

- **Personal baselines** (`risk/baseline.ts`) — rolling mean over the current ~10-minute buffer window, not a day/week personal baseline.
- **AQI** — fetched and displayed on the Environment screen, but not wired into the respiratory rule's `envMultiplier`. A judge asking "does air quality affect the risk score" would get "not yet."
- **Community summary** (`src/community/`) — real k-anonymity aggregation logic, fed entirely by a hardcoded demo cohort. Labelled "Concept demonstration" in the UI.

## Device Validated

**None of the sensing or SOS layers have ever run on a phone.** Health Connect ingestion, the accelerometer fold, and the SOS delivery machine (Twilio relay + SMS composer) exist as code with unit/integration test coverage against mocked native modules only. The single thing that has run on a device is UI rendering and live OpenWeatherMap weather, observed on an August build ("the August APK") — and even that was against a simulated vitals window, not live Health Connect data.

## Real-World Validated

None. No feature in this repository has been used by a person outside the development team, in a real disaster, heat event, or day of normal use.

## Mock/Demo

- **Trends screen** — renders hardcoded `constants/health-data.ts` `TRENDS` data. Nothing persists; the screen looks live and is not.
- **Simulated sensor window** (`constants/mock-sensor-window.ts`) — the default "Simulated data" source; the demo fallback.
- **Community cohort** (`community/demo-cohort.ts`) — hardcoded ward tally.
- **Dev "Simulate a fall" button** — splices a real impact-then-stillness motion sequence into the buffer so the real fall rule fires; proves the detector, not the UI card, and is explicitly dev-only.

## Remaining Work

Prioritised list, from the audit §D/§K:

### P0
- Link EAS, build the development client, install on a phone — nothing in the sensing layer is validated without this.
- Health Connect compatibility pass on Android 14 and 15 (permission sheet, `SkinTemperature` availability).
- Wire AQI into the respiratory rule (`envMultiplier` + an advisory rule at Unhealthy+).
- Local notifications on risk-level change and on any critical rule (currently: nothing fires with the screen off).
- Deploy the Twilio relay; end-to-end SMS test to a second phone.
- ~~`.gitattributes` + normalise line endings; merge `eas.json`~~ — done in this branch.

### P1
- Reading store on `expo-sqlite` (persist readings; feed the hook from it).
- Trends screen fed from the store; delete the `TRENDS` constant.
- Background sensing: Android foreground service running polling + accelerometer fold with the screen off.
- User profile (age band, chronic condition, outdoor worker) → vulnerability multiplier.
- 7-day personal baselines (resting HR, SpO₂) from the store.
- Tier-2 personal-baseline anomaly score (EWMA/z-score), explainable, fused into `envMultiplier`/score.
- Hindi UI strings (i18n scaffolding).

### P2
- Sleep (`SleepSession`) and steps as fatigue/activity inputs.
- Flood/cyclone cards surfaced by weather alerts/rain (still unattributed).
- Encrypt settings/contacts (`expo-secure-store`).
- Maestro E2E for the demo flow.
- ESP32 BLE adapter (only if a teammate has the board).

### P3
- HealthKit adapter; caregiver app; aggregate backend; official IMD/NDMA/CPCB feeds; CDSCO regulatory positioning.

## Known Bugs

None open. One item is **unverified, not a confirmed bug**: `readRecords('SkinTemperature')` may throw on a Health Connect version older than 1.1, which would make every poll report `error` until confirmed on a device.

## Known Risks

- Foreground-only sensing means a fall with the phone in a pocket, screen off, is not detected today.
- No persistence: killing the app loses the last ~20 minutes of buffered readings; Trends cannot reflect history until a store exists.
- Settings (contacts, name) are stored in plaintext AsyncStorage, not encrypted, despite the PRD's SQLCipher goal.
- The SOS Twilio relay is undeployed; the only tested-on-device path is the native SMS composer fallback, and even that has not been run on a device yet.
- `SkinTemperature` behaviour on Health Connect <1.1 is unverified.

## Current Demo Capability

Simulated vitals window (default source) with a real rule engine scoring it; live weather/AQI for the phone's city; a dev "Simulate a fall" button that drives the real fall detector; SOS countdown → cancel or SMS composer (no relay). Trends and Community are static. The Dashboard subtitle honestly reads "Simulated data" whenever the simulated window is the newest source.

## SIH Readiness

🟡 **Needs Major Work** — the decision layer (rule engine, environment fusion, SOS logic) is genuinely strong and well tested, but three PS-critical capabilities — device-validated live sensing, background operation, and persisted history with notifications — do not exist yet, so the prototype's strongest claims currently rest on a simulated window rather than a phone.

## Next Milestone

**M1 — device validation.** Get the Health Connect development build running on a phone and validate the sensing → risk → SOS path end to end. Blocked on: an EAS/Expo account to run the build, a physical Android phone (or Health Connect Toolbox) to supply real records, and a deployed Twilio relay (or a second phone for the SMS composer fallback test).
