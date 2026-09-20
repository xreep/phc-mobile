# Project status

**Current Version:** 0.2.0 — see [`CHANGELOG.md`](../CHANGELOG.md). 0.3.0 = current `master` after PRs #3–#11 (2026-09-19); not yet tagged
(AQI respiratory advisory, local notifications, user profile capture).

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

## Implemented (merged 2026-09-19, not device validated)

Built and tested on feature branches, not yet on `master` — each PR is open, reviewed, and not
merged. None has run on a device.

- **AQI → respiratory risk advisory** (`src/risk/rules/respiratory.ts`, `src/risk/aqi-bands.ts`) —
  above EPA AQI 150 the respiratory card raises an advisory (level/score/guidance) without ever
  setting the PRD §7.2.2 respiratory flag or triggering SOS. Branch `feat/aqi-respiratory-advisory`.
  *Built · Unit tested · Integration tested (Jest) · Device validated: NO · merged to master (not
  merged).* See [`docs/features/aqi-respiratory-advisory.md`](features/aqi-respiratory-advisory.md).
- **Local risk-change notifications** (`src/alerts/`, `src/hooks/use-alerts.ts`) — foreground-only
  local notifications when a category rises to elevated/high or a critical trigger appears, reusing
  the same rule engine output as the Dashboard cards. Branch `feat/alert-notifications`.
  *Built · Unit tested · Integration tested (Jest) · Device validated: NO · merged to master (not
  merged).* See [`docs/features/notifications.md`](features/notifications.md).
- **User profile capture ("About you")** (`src/settings/profile.ts`) — age band, chronic condition,
  outdoor worker, pregnant status, captured in Settings; a proven no-op for the risk engine today
  (ADR-005 defers applying it to thresholds). Branch `feat/user-profile`.
  *Built · Unit tested · Integration tested (Jest) · Device validated: NO · merged to master (not
  merged).* See [`docs/features/user-profile.md`](features/user-profile.md).

## Partially Implemented

- **Personal baselines** (`risk/baseline.ts`) — rolling mean over the current ~10-minute buffer window, not a day/week personal baseline.
- **AQI (on `master`)** — fetched and displayed on the Environment screen, but not yet wired into the respiratory rule's `envMultiplier`/advisory on `master` — that wiring exists in the unmerged `feat/aqi-respiratory-advisory` PR above. Until it merges, a judge asking "does air quality affect the risk score" against `master` would get "not yet."
- **Community summary** (`src/community/`) — real k-anonymity aggregation logic, fed entirely by a hardcoded demo cohort. Labelled "Concept demonstration" in the UI.

## Device Validated

**First device run: 2026-09-20, one Android 15 phone, EAS development client (build `5b4de821`).**
Results table: [`docs/validation/device-validation-plan.md`](validation/device-validation-plan.md).

Validated on that device:
- EAS dev-client install and Metro connection over tunnel.
- Health Connect: permission sheet lists Heart rate, Blood oxygen, Skin temperature; grant reaches the app; `HeartRateSeries` and `OxygenSaturation` records written by Health Connect Toolbox appear in the vitals row within one 60-s poll; a 40-min-old record is correctly ignored (outside the 20-min retention window).
- Risk engine on real data: SpO₂ 91 % → Respiratory *Alert* (`respiratory.spo2.low`); local AQI 177 → *Caution* advisory (PR #6) on real air-quality data; two SpO₂ 80 % samples → **critical** → vibration → 30-s countdown.
- SOS fallback path: countdown expiry opened the SMS composer pre-filled and addressed to the contact (relay not configured, so the composer path was exercised; the user pressed send).
- Notifications: a "Respiratory risk: high" notification arrived on the device — **after** a device-found fix (PR #14): without a foreground handler `expo-notifications` suppressed every alert, since sensing is foreground-only. Notification permission was `denied` on first run and was picked up on the next foreground after enabling it in App info.

Still **not** device validated: skin-temperature records, accelerometer/fall on a real drop, the Twilio relay (blocked on Twilio KYC — see Blockers), airplane-mode behaviour, Android 14, battery.

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
- Link EAS, build the development client, install on a phone — nothing in the sensing layer is validated without this. **BLOCKED on user action:** an Expo/EAS account (`eas login` / `eas init`).
- Health Connect compatibility pass on Android 14 and 15 (permission sheet, `SkinTemperature` availability). **BLOCKED on user action:** a physical Android phone.
- ~~Wire AQI into the respiratory rule (`envMultiplier` + an advisory rule at Unhealthy+).~~ — **Done — merged (PR #6).** see [`docs/features/aqi-respiratory-advisory.md`](features/aqi-respiratory-advisory.md). Not device validated.
- ~~Local notifications on risk-level change and on any critical rule.~~ — **Done — merged (PR #8).** foreground-only; see [`docs/features/notifications.md`](features/notifications.md). Not device validated.
- Deploy the Twilio relay; end-to-end SMS test to a second phone. **BLOCKED on user action:** a Twilio account (and relay deploy) plus a second physical phone.
- Airplane-mode SOS composer-fallback test. **BLOCKED on user action:** a physical phone.
- Push the parked CI workflow (`ci/github-actions` branch, commit `99761e2`). **BLOCKED on user action:** the GitHub PAT in use lacks the `workflow` scope needed to push a workflow file (or run `gh auth login` with that scope).
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

## CI

GitHub Actions (`.github/workflows/ci.yml`, PR #4): `tsc --noEmit`, `eslint src --max-warnings 0`,
`jest --ci` on every push and PR, plus an advisory `expo-doctor` job. First fully green run:
PR #11 (2026-09-19) after aligning 18 Expo packages and RN 0.86.3 with SDK 57. Jest `testTimeout`
is 15 s (PR #5) because the first cold Dashboard render exceeded 5 s on a shared runner once.

## Known Risks

- Foreground-only sensing means a fall with the phone in a pocket, screen off, is not detected today.
- No persistence: killing the app loses the last ~20 minutes of buffered readings; Trends cannot reflect history until a store exists.
- Settings (contacts, name) are stored in plaintext AsyncStorage, not encrypted, despite the PRD's SQLCipher goal.
- The SOS Twilio relay is undeployed; the only tested-on-device path is the native SMS composer fallback, and even that has not been run on a device yet.
- `SkinTemperature` behaviour on Health Connect <1.1 is unverified.

## Decisions awaiting human sign-off (health methodology)

Implemented per an approved plan, but each item below is flagged in its own feature doc for a
domain-expert veto before merge — none of these has been reviewed by a health professional:

- **AQI advisory line: strict >150.** The respiratory advisory only fires above EPA AQI 150 (the
  151–200 "Unhealthy" band and up); at exactly 150 or below, no card-level change occurs for
  anyone, including sensitive groups. See [`docs/features/aqi-respiratory-advisory.md`](features/aqi-respiratory-advisory.md).
- **Advisory scores 40/55/70** for Unhealthy / Very Unhealthy / Hazardous. The Hazardous band (70)
  reaches **red without ever setting the PRD §7.2.2 respiratory flag or triggering SOS** — only
  SpO₂ < 92% flags or triggers SOS today.
- **Environment-screen colour (red at 151+) vs. the respiratory card (amber at the same AQI)
  disagree** — a deliberate difference (the screen colours the air, the card colours the advisory
  risk) that is a product decision, not yet made by a human, on whether the two should agree.
- **Guidance ladder wording** (e.g. N95/FFP2 mask use, inhaler use) in the AQI advisory's
  recommendation ladder — clinical phrasing that has not been reviewed by a health professional.
- **Profile → threshold personalisation deferred** (ADR-005). The new "About you" profile fields
  are captured but are a proven no-op for risk thresholds today; applying them to thresholds or
  notification urgency is a separate, human-reviewed milestone (`docs/ROADMAP.md` M9).

## Current Demo Capability

Simulated vitals window (default source) with a real rule engine scoring it; live weather/AQI for the phone's city; a dev "Simulate a fall" button that drives the real fall detector; SOS countdown → cancel or SMS composer (no relay). Trends and Community are static. The Dashboard subtitle honestly reads "Simulated data" whenever the simulated window is the newest source.

Three further features are built, unit- and integration-tested, and sitting in open, reviewed PRs
(merged to master 2026-09-19, none device validated — see "Implemented" above): an AQI-driven respiratory
advisory, local risk-change notifications (foreground-only), and a user-profile capture screen (not
yet wired to any risk threshold).

## SIH Readiness

🟡 **Needs Major Work** — the decision layer (rule engine, environment fusion, SOS logic) is genuinely strong and well tested, but three PS-critical capabilities — device-validated live sensing, background operation, and persisted history with notifications — do not exist yet, so the prototype's strongest claims currently rest on a simulated window rather than a phone.

## Next Milestone

**M1 — device validation.** Get the Health Connect development build running on a phone and validate the sensing → risk → SOS path end to end. This also gates merging the three PRs above onto `master`, since none has run on a device. Blocked on: an EAS/Expo account to run the build, a physical Android phone (or Health Connect Toolbox) to supply real records, and a deployed Twilio relay (or a second phone for the SMS composer fallback test).
