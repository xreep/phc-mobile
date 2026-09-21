# Project status

**Current Version:** 0.4.0-pending — see [`CHANGELOG.md`](../CHANGELOG.md). Current `master` after
PRs #3–#22 (2026-09-19 → 2026-09-21); not yet tagged (AQI respiratory advisory, local notifications,
user profile capture, persisted reading store, real Trends, multi-channel emergency relay + app-side
dispatch/linking).

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

## Implemented (merged 2026-09-19 – 2026-09-21, not device validated)

Built and tested on feature branches, not yet on `master` — each PR is open, reviewed, and not
merged. None has run on a device.

- **Local reading store** (`src/store/`) — `expo-sqlite`, 7-day retention, "Erase my health data"
  control in Settings. PR #17 (M6). *Built · Unit tested · Integration tested (screen-level, memory
  backend) · Device validated: NO — a new EAS build is in progress.* See
  [`docs/features/reading-store.md`](features/reading-store.md).
- **Real Trends from the store** (`src/trends/aggregate.ts`, `src/hooks/use-trends.ts`) — 24 h / 7 d
  min/avg/max and a sparkline read from the reading store; the hardcoded `TRENDS` constant is
  deleted. PR #19 (M7). *Built · Unit tested · Integration tested (screen-level, memory backend) ·
  Device validated: NO.* See [`docs/features/trends.md`](features/trends.md).
- **Multi-channel emergency relay** (`relay/`, M5 part 1a/1b) — a Cloudflare Worker deployed at
  `https://phc-sos-relay.xreep.workers.dev` delivering over Telegram (primary), Textbelt SMS or
  Twilio SMS; the app now sends the structured dispatch contract and links a caregiver's Telegram
  from Settings. PRs #18/#20/#22. *Relay: Built · Unit tested (vitest, 142) · **Telegram lane
  device validated by hand 2026-09-21** (`/start <linkToken>` → `/link` → `/sos` delivered to a real
  Telegram account in ~1 s). Textbelt: free SMS is blocked for India ("free SMS are disabled for
  this country due to abuse") — the relay returned 502 as designed and the phone fell back to the
  composer. Twilio: code kept, disabled (KYC + paid top-up). App-side dispatch + linking: Built ·
  Unit/Integration tested (Jest) · Device validated: NO — the on-phone test is next.* See
  [`docs/features/sos-relay.md`](features/sos-relay.md),
  [`ADR-007`](decisions/ADR-007-multi-channel-relay.md).
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

**Second device event: 2026-09-21, the deployed emergency relay, Telegram lane, validated by hand
(`curl`, not the app).** `/start <linkToken>` → `/link` → `/sos` delivered a real message to a real
Telegram account in ~1 s — recorded in
[`relay/README.md`](../../relay/README.md#status--read-this-first) and
[`docs/validation/device-validation-plan.md`](validation/device-validation-plan.md). Textbelt SMS
was exercised the same day and found blocked for India on the free tier ("free SMS are disabled for
this country due to abuse"); the relay correctly answered 502 and the phone's fallback design (native
SMS composer) is what would have opened. This is a relay-only validation event — no app build has
yet sent an SOS through the deployed relay.

Still **not** device validated: skin-temperature records, accelerometer/fall on a real drop,
airplane-mode behaviour, Android 14, battery, the persisted reading store, the Trends screen, and the
app-side relay dispatch/Telegram linking (all three await the next EAS build).

## Real-World Validated

None. No feature in this repository has been used by a person outside the development team, in a real disaster, heat event, or day of normal use.

## Mock/Demo

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
- ~~Deploy the Twilio relay; end-to-end SMS test to a second phone.~~ — **Done, differently.** A
  provider-agnostic relay (Cloudflare Worker) is deployed at `phc-sos-relay.xreep.workers.dev`;
  its Telegram lane is device validated by hand (2026-09-21). Twilio itself stays disabled (KYC +
  paid top-up) — now a documented limitation, not a blocker, since Telegram is the primary
  automatic channel. See [`docs/features/sos-relay.md`](features/sos-relay.md).
- **On-phone validation of the reading store, Trends, and the app-side SOS relay
  dispatch/Telegram linking** — pending the new EAS build. Not blocked on any external account;
  next validation event once the build is available.
- Airplane-mode SOS composer-fallback test. **BLOCKED on user action:** a physical phone.
- Push the parked CI workflow (`ci/github-actions` branch, commit `99761e2`). **BLOCKED on user action:** the GitHub PAT in use lacks the `workflow` scope needed to push a workflow file (or run `gh auth login` with that scope).
- ~~`.gitattributes` + normalise line endings; merge `eas.json`~~ — done in this branch.

### P1
- ~~Reading store on `expo-sqlite` (persist readings; feed the hook from it).~~ — **Done (M6, PR
  #17).** Not yet device validated. See [`docs/features/reading-store.md`](features/reading-store.md).
- ~~Trends screen fed from the store; delete the `TRENDS` constant.~~ — **Done (M7, PR #19).** Not
  yet device validated. See [`docs/features/trends.md`](features/trends.md).
- **FCM caregiver role (M5 part 2)** — push adapter + `EmergencyContact.pushToken`, once a
  caregiver role exists in the app. Planned; the relay's `fcm` adapter is currently a stub.
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
- The reading store (`expo-sqlite`, M6) and real Trends (M7) are merged but **not yet device
  validated** — a new EAS build is in progress; killing the app before that build's device run is
  confirmed should be assumed to behave as documented in `docs/features/reading-store.md`'s Device
  Validation section, not yet proven on a phone.
- Settings (contacts, name) are stored in plaintext AsyncStorage, not encrypted, despite the PRD's SQLCipher goal. The new reading store is plaintext too until M12 (ADR-006).
- The emergency relay is deployed and its Telegram lane is device validated (2026-09-21); the
  app-side dispatch and Telegram linking that speak to it are **not yet** device validated — the
  only tested-on-device SOS path remains the native SMS composer fallback. Textbelt free SMS is
  confirmed blocked for India; Twilio stays disabled (KYC + paid top-up), a documented limitation
  rather than a blocker since Telegram is primary.
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

Simulated vitals window (default source) with a real rule engine scoring it; live weather/AQI for the phone's city; a dev "Simulate a fall" button that drives the real fall detector; SOS countdown → cancel, an emergency relay POST (Telegram primary, SMS gateway secondary), or SMS composer fallback. Trends now reads real 24h/7d history from the persisted store when one exists. Community is static. The Dashboard subtitle honestly reads "Simulated data" whenever the simulated window is the newest source.

Six further features are built, unit- and integration-tested, and merged to `master` (PRs #6–#22,
2026-09-19 → 2026-09-21), none device validated except where noted — see "Implemented" above: an
AQI-driven respiratory advisory, local risk-change notifications (foreground-only), a user-profile
capture screen (not yet wired to any risk threshold), a persisted reading store, real Trends, and a
multi-channel emergency relay whose Telegram lane **is** device validated (the app-side dispatch
and linking that speak to it are not).

## SIH Readiness

🟡 **Needs Major Work** — the decision layer (rule engine, environment fusion, SOS logic) is genuinely strong and well tested, and persisted history, real Trends, and a multi-channel emergency relay (Telegram lane device validated) are now merged, but device-validated live sensing beyond the first run, background operation, and on-phone validation of the store/Trends/app-side SOS dispatch do not exist yet, so the prototype's strongest claims still rest partly on a simulated window and unit tests rather than a phone.

## Next Milestone

**M8 — background sensing.** With M5 (relay, part 1)/M6 (reading store)/M7 (real Trends) merged and
their on-phone validation pending only a new EAS build, the next unbuilt milestone is an Android
foreground service that keeps polling and the accelerometer fold running with the screen off — the
single biggest gap between the current prototype and the PS's "automatic detection" promise (see
`docs/ROADMAP.md` M8). In parallel: the on-phone validation run for the store/Trends/app-side SOS
relay dispatch once the new EAS build lands, and M5 part 2 (FCM adapter + caregiver role).
