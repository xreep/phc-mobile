# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

**Validation for every entry below:** unit/integration tests only (Jest + React Native Testing
Library, against mocked native modules where relevant; the relay uses vitest against a stubbed
`fetch`), except where an entry says otherwise. Device-validated so far: UI and live
OpenWeatherMap weather (August APK, simulated vitals window), the first Health Connect/SOS-composer
run (2026-09-20), and the deployed emergency relay's Telegram lane (2026-09-21, by hand). See
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md).

## [Unreleased]

### Fixed
- Notifications: register a foreground notification handler — `expo-notifications` suppressed
  every alert because sensing is foreground-only (found on the first device run; PR #14).

### Validation
- 2026-09-20, Android 15, EAS dev client: Health Connect HeartRate + SpO₂ reads, permission
  sheet, AQI advisory on real air, SpO₂ flag and critical → SOS countdown → SMS composer, and
  notification delivery are **device validated**. See `docs/validation/device-validation-plan.md`.
- 2026-09-21, deployed emergency relay (Cloudflare Worker), Telegram lane: `/start <linkToken>` →
  `/link` → `/sos` delivered a real message to a real Telegram account in ~1 s (by hand, `curl`) —
  **device validated**. Textbelt SMS answered "free SMS are disabled for this country due to
  abuse" for an Indian number; the relay correctly returned 502 and the phone's design falls back
  to the composer. The persisted reading store, real Trends, and the app's own relay
  dispatch/Telegram linking are merged but **not** device validated — pending a new EAS build.

### Added
- Local reading store (`src/store/`): a persistent, 7-day `expo-sqlite` store of `SensorReading`s
  underneath the live sensor feed, so readings survive an app restart. Dedupe, prune, and an
  "Erase my health data" control in Settings → Data sharing. Plaintext until M12 (ADR-006). Never
  written while on the simulated source. (M6, PR #17.) See `docs/features/reading-store.md`.
- Trends screen: 24 h / 7 d min/avg/max and a sparkline computed from the persisted reading store
  (`src/trends/aggregate.ts`, `src/hooks/use-trends.ts`), replacing the hardcoded `TRENDS`
  constant. Honest empty states for the simulated source, no data yet, and a memory-backend
  fallback. (M7, PR #19.) See `docs/features/trends.md`.
- Multi-channel emergency relay (`relay/`, M5 part 1a): a Cloudflare Worker, deployed at
  `https://phc-sos-relay.xreep.workers.dev`, delivering an SOS over Telegram (primary), Textbelt
  SMS, or Twilio SMS (kept, disabled), whichever is configured, and reporting per-channel results.
  Provider credentials never reach the phone. (PRs #18/#20.) See `docs/features/sos-relay.md`,
  `docs/decisions/ADR-007-multi-channel-relay.md`.
- SOS dispatch speaks the multi-channel relay's contract (`{ to: { phone, telegramChatId? },
  message, channels }`, success = 2xx + `delivered: true`, per-channel results); `src/sos/relay.ts`
  replaces `twilio.ts`. Emergency contacts can link a Telegram chat from Settings via an
  app-generated 128-bit deep link (`expo-crypto`), polled every 10 s for 10 min. The SOS overlay
  reports per contact ("Sent to Meera via Telegram", "Opened SMS app for Raj"). Settings shows a
  Telegram badge on linked contacts. (M5 part 1b, PR #22.)
- `.gitattributes` (LF normalisation) and CI (typecheck, lint, test on every push and PR to `master`).
- This documentation tree (`docs/PROJECT_STATUS.md`, `docs/BUILD_MATRIX.md`, `docs/ROADMAP.md`,
  `docs/JUDGE_QA.md`, architecture/security/testing/validation docs, ADRs).
- Respiratory rule: air-quality advisory precursor (`respiratory.aqi.unhealthy` / `.veryUnhealthy`
  / `.hazardous`) at EPA AQI 151+ / 201+ / 301+, scoring 40 / 55 / 70 — moves the card's level and
  guidance, never the SpO₂ flag or SOS. Applies only to a weather observation within 60 minutes.
  New thresholds `env.aqiAdvisoryAbove`, `env.aqiUnhealthyScore`, `env.aqiVeryUnhealthyScore`,
  `env.aqiHazardousScore`. `envMultiplier` unchanged. (PR #6, merged.) See `docs/features/aqi-respiratory-advisory.md`.
- Local notifications when a risk category rises to elevated/high or a critical trigger appears
  (`src/alerts/`, `src/hooks/use-alerts.ts`), with a new "Alerts" section and toggle in Settings.
  Foreground-only. (PR #8, merged.) See
  `docs/features/notifications.md`.
- User profile ("About you" in Settings): age band, chronic condition, outdoor worker, and
  pregnant status, captured locally and validated on read. Currently a no-op for risk
  assessment — see ADR-005; personalised thresholds are a future, separately reviewed milestone.
  (PR #7, merged.) See `docs/features/user-profile.md`.

### Changed
- `EXPO_PUBLIC_SOS_RELAY_URL` (must end in `/sos`) replaces `EXPO_PUBLIC_TWILIO_SOS_URL`; the old
  name is still read for one release when it points at the Worker. Optional
  `EXPO_PUBLIC_SOS_RELAY_KEY` → `X-PHC-Key`. `SosDispatchResult.twilioSent` → `relayDelivered`;
  `DispatchOptions.twilio`/`skipTwilio` → `relay`/`skipRelay`. A 2xx response without
  `delivered: true` now falls back to the composer, where a bare 204 used to be accepted.

### Removed
- Unused `create-expo-app` template leftovers (`external-link`, `web-badge`, `hint-row`,
  `ui/collapsible`) and `scripts/reset-project.js`.
- `TRENDS`, `TrendSeries`, and the Trends screen's "Example data" sample banner
  (`constants/health-data.ts`, `app/trends.tsx`) — superseded by real store-backed history (`TrendRange` kept).
- `src/sos/twilio.ts` — replaced by `src/sos/relay.ts`; every import updated.

**Validation:** unit/integration tests only for every entry in this release except where noted
above (relay's Telegram lane device validated 2026-09-21; sensing/SOS-composer device validated
2026-09-20). Tests: 63 suites / 1457 (app, Jest); 142 (relay, vitest). CI: test + `expo-doctor` +
relay jobs green.
**Known limitations:** the AQI advisory's colour disagreement with the Environment screen, its
band/score numbers, and its guidance wording are pending human (health-methodology) sign-off — see
`docs/PROJECT_STATUS.md` "Decisions awaiting human sign-off". Notifications are foreground-only.
The user profile does not yet affect any risk threshold (ADR-005). Textbelt's free SMS tier is
blocked for India ("free SMS are disabled for this country due to abuse" — confirmed 2026-09-21);
the relay falls back to the phone's SMS composer path as designed. Twilio stays disabled (KYC +
paid top-up). The reading store, Trends, and the app's own relay dispatch/Telegram linking are
merged but **not device validated** — a new EAS build is in progress; only the relay's Telegram
lane has been validated on real hardware so far.

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
