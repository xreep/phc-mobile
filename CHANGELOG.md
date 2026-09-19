# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

**Validation for every entry below:** unit/integration tests only (Jest + React Native Testing
Library, against mocked native modules where relevant). Nothing in this changelog has been device-
or real-world validated except UI and live OpenWeatherMap weather, observed on the August APK build
against a simulated vitals window. See [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).

## [Unreleased]

### Added
- `.gitattributes` (LF normalisation) and CI (typecheck, lint, test on every push and PR to `master`).
- This documentation tree (`docs/PROJECT_STATUS.md`, `docs/BUILD_MATRIX.md`, `docs/ROADMAP.md`,
  `docs/JUDGE_QA.md`, architecture/security/testing/validation docs, ADRs).

### Removed
- Unused `create-expo-app` template leftovers (`external-link`, `web-badge`, `hint-row`,
  `ui/collapsible`) and `scripts/reset-project.js`.

**Known limitations:** repository hygiene and documentation only — no application behaviour changed.

## [0.2.0] — 2026-09-15

### Added
- Live Health Connect sensor ingestion: heart rate, SpO₂, and skin-temperature (baseline+delta)
  polling every 60 s, gated behind the Settings "Sensor source" picker.
- Phone accelerometer fold into a per-minute `MotionSummary`, feeding the fall and stillness rules.
- `SensorProvider` and `useSensorFeed()`, mounted inside `SettingsProvider`.
- Dashboard live-feed notice explaining an empty feed (permission / unavailable / waiting) and
  offering the Health Connect permission prompt.
- SOS message composer now quotes the newest live vitals.
- `eas.json` — EAS development-client build profile for on-device Health Connect testing.
- Engine fix: `longestStillRunMs` / `trailingStillRunMs` now skip motion-less readings instead of
  breaking a still run on them, so a live buffer with HR samples interleaved between per-minute
  motion readings can still satisfy the fall and heat-stillness rules (previously unsatisfiable on
  the real ingestion shape).

**Validation:** unit/integration tests only (mocked `react-native-health-connect` and `expo-sensors`
in `jest/setup-after-env.js`); not device validated.
**Known limitations:** foreground-only — polling and the accelerometer fold stop when the app is
backgrounded; no reading persistence; `SkinTemperature` availability on Health Connect <1.1 is
unverified; the Twilio relay is not deployed.

## [0.1.0] — 2026-08-24

### Added
- App shell: 5-tab Expo Router navigation (Dashboard, Trends, Environment, Community, Settings).
- Tier-1 rule engine (`src/risk/`): heat, respiratory, cardiovascular, dehydration, fatigue, and
  fall detection, with tiered plain-language recommendations selected by score.
- Personal baseline tracking on the vitals row (rolling mean over the current window).
- Environment module: coarse-location weather + AQI via OpenWeatherMap, with an offline cache.
- Preparedness advisory cards (flood/cyclone), explicitly unattributed to any agency.
- Emergency SOS: state machine with a 30-second cancel window, GPS fix, message composer, Twilio
  relay integration, and per-contact native SMS composer fallback.
- Settings: emergency contacts (E.164 normalised), display name, sharing preferences, sensor source
  picker.
- Opt-in, anonymised community ward summary with a k-anonymity floor (demo cohort).

**Validation:** unit/integration tests only; not device validated.
**Known limitations:** no persistence anywhere; Trends screen renders static constants; Community
screen is fed by a hardcoded demo cohort; no notifications; no background operation; settings stored
in plaintext AsyncStorage.
