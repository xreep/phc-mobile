# Personal Health Companion (PHC)

Mobile app for Smart India Hackathon Problem Statement **26181** — an AI-powered Personal Health
Companion for disaster resilience.

## Problem

India faces recurring public-health challenges during and after disasters — heat stress,
dehydration, respiratory illness, cardiovascular complications, and delayed access to care, often
worsened by heat waves, floods, cyclones, and air-pollution events. There is a need for a secure,
privacy-preserving Personal Health Companion that monitors key vitals continuously, warns users
before a physiological risk becomes an emergency, fuses that risk with local environmental
conditions, and can reach an emergency contact even with poor connectivity — without raw health data
leaving the user's phone.

## Solution

PHC reads vitals from whatever band or phone sensor a user already has (via Android Health Connect,
plus the phone's own accelerometer), scores them with an on-device rule engine fused with live
weather/AQI, and — on a critical event — starts a 30-second SOS countdown that texts emergency
contacts with the user's vitals and location, entirely without a backend holding any of that data.

## Architecture

See [`docs/architecture/overview.md`](docs/architecture/overview.md) for the full data-flow diagram.
In short: Health Connect and the accelerometer feed adapters into one `SensorReading` schema → a
persisted `expo-sqlite` reading store → the pure rule engine (fused with an environment snapshot) →
the Dashboard/Trends and, on a critical rule, the SOS state machine → the multi-channel emergency
relay (Telegram/SMS) or native SMS composer fallback.

## Major features and validation status

Every status below uses the ladder: **Built / Unit tested / Integration tested / Device validated /
Real-world validated / Mock-demo / Planned**. Full detail in
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) and [`docs/BUILD_MATRIX.md`](docs/BUILD_MATRIX.md).

| Feature | Status |
| --- | --- |
| Rule-based risk engine (heat, respiratory, cardiovascular, fall, dehydration, fatigue) | Built · Unit tested |
| Environment context (weather + AQI, offline cache) | Built · Unit/integration tested · live weather seen on the August APK |
| Health Connect ingestion (HR, SpO₂, skin temp) + accelerometer fold | Built · Unit tested against mocked native modules — **not device validated** |
| Local reading store (`expo-sqlite`, 7-day retention, erase control) | Built · Unit/integration tested — **not device validated** (new EAS build in progress) |
| Trends screen (real 24h/7d history from the store) | Built · Unit/integration tested — **not device validated** |
| Emergency relay (Cloudflare Worker: Telegram, Textbelt, Twilio) | Built · Unit tested (vitest, 142) · **Telegram lane device validated** (2026-09-21); Textbelt blocked for India; Twilio disabled |
| Emergency SOS (app-side relay dispatch + Telegram linking, SMS composer fallback) | Built · Unit/integration tested — relay dispatch **not device validated**; composer fallback device validated |
| Settings (contacts, sharing prefs, sensor source) | Built · Unit tested · plaintext AsyncStorage (not encrypted) |
| Community ward summary | Mock-demo — real aggregation logic, hardcoded demo cohort |
| Background sensing | Planned |

**Nothing in this repository is device- or real-world-validated except UI rendering, live
OpenWeatherMap weather (August development build, simulated vitals window), the first Health
Connect/SOS-composer run, and the deployed relay's Telegram lane (validated by hand, 2026-09-21).**

## AI approach

Today, risk assessment is a deterministic, on-device rule engine — not a trained model. Every
threshold is sourced to public guidance (NOAA heat index; WHO/AHA SpO₂ and HR bands, cited in
`src/risk/config.ts`) and requires sustained evidence before escalating. The engine's outputs are
shaped to fuse with a learned tier later; none has shipped. The planned next step is an explainable,
on-device personal-baseline anomaly score (deviation from the user's own history), evaluated before
any TFLite model — see [`ADR-002`](docs/decisions/ADR-002-rules-before-ml.md) for why. No accuracy,
sensitivity, or false-positive figure is claimed anywhere in this repository; none has been measured.

This app provides a **risk indication** and a **recommendation to seek help** — it does not
diagnose any condition.

## Privacy model

All physiological analysis runs on the device; no vital reading (HR, SpO₂, skin temperature, motion)
is ever transmitted or stored on a server. The only network calls are coarse-location weather/AQI
requests and the SOS SMS itself (via a credential-holding relay the app never touches, or the native
SMS composer). Settings and the weather cache are stored in plaintext AsyncStorage today — flagged as
a known gap against the PRD's encrypted-storage goal. Full detail:
[`docs/security/privacy-architecture.md`](docs/security/privacy-architecture.md).

## Hardware

Today: any HR/SpO₂/skin-temperature-capable band or watch that writes to Android Health Connect — no
custom hardware required. Future (stretch): an ESP32-based BLE prototype, only if a teammate already
has the board — see `docs/ROADMAP.md`.

## Setup

Requires Node 22 and an Android device or emulator with Health Connect (Health Connect is a native
module, so **Expo Go cannot run this app**).

```bash
export PATH="/opt/homebrew/bin:$PATH"   # or however Node 22 is on your PATH
npm ci
```

Create `.env.local` (gitignored):
```
EXPO_PUBLIC_OPENWEATHER_API_KEY=your_key_here
# optional — leave unset to use the native SMS composer fallback for SOS. Must end in /sos
# (a bare origin is treated as not configured). The old EXPO_PUBLIC_TWILIO_SOS_URL name is
# still read for one release when it points at the same Worker.
EXPO_PUBLIC_SOS_RELAY_URL=https://<worker>/sos
# optional — sent as the X-PHC-Key header when the deployment requires it
EXPO_PUBLIC_SOS_RELAY_KEY=
```

The SOS relay itself (`relay/`) is a Cloudflare Worker deployed at
`https://phc-sos-relay.xreep.workers.dev`, delivering over Telegram (device validated), Textbelt
SMS (blocked for India on the free tier), or Twilio SMS (kept, disabled). See
[`docs/features/sos-relay.md`](docs/features/sos-relay.md) for the full contract and status.

Build and run a development client:
```bash
npx expo prebuild --platform android
eas build --profile development --platform android
```

## Testing

```bash
npm test                          # 63 suites / 1457 tests
npx tsc --noEmit                  # typecheck
npx eslint src --max-warnings 0   # lint

cd relay && npm test              # 142 tests (vitest); also npm run typecheck / npm run check
```

All app tests are unit/integration tests against mocked native modules (Jest + React Native
Testing Library); the relay's tests are vitest against a stubbed `fetch`. See
[`docs/testing/validation-levels.md`](docs/testing/validation-levels.md) for
what each level of testing does and does not cover, and
[`docs/validation/device-validation-plan.md`](docs/validation/device-validation-plan.md) for the
protocol to reach device validation.

## Demo

**Current capability:** a simulated vitals window (default, clearly labelled "Simulated data") scored
by the real rule engine; live weather/AQI for the phone's city; a dev-only "Simulate a fall" control
that drives the real fall detector on real motion data; Trends reads real history from the on-device
store when one exists; an SOS countdown → cancel, an emergency-relay POST (Telegram/SMS, not yet
exercised from the app on a device), or an SMS composer opens pre-filled. Community is static/demo
data. See
[`docs/JUDGE_QA.md`](docs/JUDGE_QA.md) for the honest answer to "what's actually working" and every
other likely judge question.

## Limitations

No background sensing (the app detects nothing with the screen off); the reading store, Trends, and
the app's own emergency-relay dispatch are merged but not yet device validated (new EAS build in
progress); Textbelt free SMS is blocked for India and Twilio stays disabled (KYC + paid top-up);
settings are stored unencrypted. Full list:
[`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) → Known Risks.

## Roadmap

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the milestone-by-milestone path from here to a
pilot-ready build.

## Docs index

- [`docs/PROJECT_STATUS.md`](docs/PROJECT_STATUS.md) — current state, remaining work
- [`docs/BUILD_MATRIX.md`](docs/BUILD_MATRIX.md) — per-capability validation table
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — milestones M0–M12
- [`docs/JUDGE_QA.md`](docs/JUDGE_QA.md) — honest answers to expected judge questions
- [`CHANGELOG.md`](CHANGELOG.md) — release history
- [`docs/architecture/overview.md`](docs/architecture/overview.md) — data flow, providers
- [`docs/security/privacy-architecture.md`](docs/security/privacy-architecture.md) — permissions, data handling
- [`docs/testing/validation-levels.md`](docs/testing/validation-levels.md) — testing ladder
- [`docs/validation/device-validation-plan.md`](docs/validation/device-validation-plan.md) — device validation protocol
- [`docs/decisions/`](docs/decisions/) — architecture decision records
- [`docs/features/`](docs/features/) — per-feature docs (Health Connect, SOS relay)
- [`docs/prototype-audit-2026-09-19.md`](docs/prototype-audit-2026-09-19.md) — the full audit this documentation tree implements
