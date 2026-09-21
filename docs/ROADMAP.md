# Roadmap

Derived from [`docs/prototype-audit-2026-09-19.md`](prototype-audit-2026-09-19.md) §D/§E. Milestones
are grouped into the phases the audit defines; M0–M12 are this document's own numbering of the
concrete steps inside those phases so each has a single, trackable name.

## Summary: NOW → NEXT → SIH-READY → PILOT-READY → PRODUCTION → SCALE

| Stage | State |
| --- | --- |
| **NOW** | Decision layer (rule engine, environment fusion, SOS logic) built and unit/integration tested. Sensing layer, persisted readings, real Trends, and the multi-channel relay's app-side dispatch are built and merged but await device validation (a new EAS build is in progress); the relay's Telegram lane itself is already device validated. No background operation. |
| **NEXT** | Device validation of the store/Trends/app-side SOS dispatch once the new EAS build lands, plus background operation — an honest end-to-end demo on real hardware. |
| **SIH-READY** | Background sensing, user profile/personalisation, 7-day baselines, an honest Tier-2 anomaly score, Hindi UI, real Trends. |
| **PILOT-READY** | Encrypted storage, onboarding that survives permission denial, battery budget measured, Play Store health-permission approval, a written validation note per threshold. |
| **PRODUCTION** | Installable app a real family or ASHA cluster could run for a pilot. |
| **SCALE** | *Contingent on a public-health partner.* City/state/national reach needs an aggregates-only backend, official alert-feed integration, and a government or public-health program partnership — this is explicitly not a consumer-app growth path. |

---

## Milestones

### M0 — Repository hygiene, CI, documentation skeleton (this branch)
`.gitattributes`, CI on push/PR, the documentation tree itself. Gate: CI green, docs honest to the ladder.

### M1 — Device validation
Link EAS, build the development client, install on a phone, validate Health Connect readings render on the Dashboard. Gate: `Updated Ns ago · Android Health Connect` visible with a Health Connect Toolbox HR record.

### M2 — Health Connect compatibility pass
Android 14 and 15; grant/deny each permission; confirm whether `SkinTemperature` is available. Gate: permission sheet works on both OS versions; the request set is adjusted if `SkinTemperature` throws; result recorded in `docs/features/health-connect.md`.

### M3 — AQI wired into risk
`EnvironmentSnapshot.aqi` feeds the respiratory rule's `envMultiplier` and an advisory rule at Unhealthy+. Gate: tests pin the EPA band boundaries; Environment and Dashboard agree.

**Status: implemented, awaiting device validation.** Merged to master in PR #6 (reviewed) — see `docs/features/aqi-respiratory-advisory.md`. The band-boundary
gate is met by unit tests; the "Environment and Dashboard agree" gate is met for the EPA *label*
only, not the *colour* (Environment: red at 151+; Dashboard card: amber at the same AQI), which is
a pending product decision — see `docs/PROJECT_STATUS.md` "Decisions awaiting human sign-off".

### M4 — Local notifications
`expo-notifications` fires on risk-level change (amber→red) and on any critical rule, debounced per category. Gate: verified on a locked phone.

**Status: implemented, awaiting device validation.** Merged to master in PR #8 (reviewed) — see `docs/features/notifications.md`. Foreground-only today; the "verified
on a locked phone" gate is unmet (no device validation yet).

### M5 — Multi-channel emergency relay deployed
End-to-end alert test. Gate: an alert with vitals + maps link received on a second phone; airplane-mode composer fallback recorded.

**Status: part 1a (relay) done, deployed, Telegram lane device validated; part 1b (app dispatch +
linking) done, not device validated; part 2 (FCM caregiver role) pending.** Twilio required KYC and
a paid top-up for India-based accounts, so the plan changed from a Twilio-only relay
([ADR-003](decisions/ADR-003-sos-relay.md)) to a provider-agnostic one
([ADR-007](decisions/ADR-007-multi-channel-relay.md), design approved 2026-09-20, PR #15). **1a:**
the relay (`relay/`) is deployed at `https://phc-sos-relay.xreep.workers.dev` (PRs #18/#20); its
Telegram lane was device validated by hand on 2026-09-21 (`/start <linkToken>` → `/link` → `/sos`
delivered to a real Telegram account in ~1 s). Textbelt SMS is confirmed blocked for India on the
free tier (502, composer fallback as designed); Twilio's code is kept, disabled. **1b:** the app
speaks the relay's structured contract, links a caregiver's Telegram from Settings, and reports per
contact/channel (`src/sos/relay.ts`, PR #22) — built and Jest-tested, **not yet device validated**;
the on-phone test (a dev build with `EXPO_PUBLIC_SOS_RELAY_URL` set, one contact linked, one SOS
reaching a second phone on Telegram) is next, pending a new EAS build. **2 (FCM + caregiver role):
planned**, not started — the relay's `fcm` adapter is a stub. See
[`docs/features/sos-relay.md`](features/sos-relay.md).

### M6 — Reading store (`expo-sqlite`)
Readings persist across restarts; the hook reads from the store. Gate: existing engine tests stay green pointed at the store; a round-trip test survives an app restart.

**Status: implemented, awaiting device validation.** Merged in PR #17 — `src/store/` gives the feed
a persistent, 7-day `expo-sqlite` store with an "Erase my health data" control; the memory backend
plus fake-driver contract tests are green. See [`docs/features/reading-store.md`](features/reading-store.md)
and [`ADR-006`](decisions/ADR-006-local-reading-store.md). Device validation is pending a new EAS
build (the config plugin `expo-sqlite` added in this PR has not yet been run on a phone).

### M7 — Real Trends
Trends screen reads 24 h / 7 d history from the store; the `TRENDS` constant is deleted. Gate: empty-state when no history exists; values match hand-computed aggregates on a seeded DB.

**Status: implemented, awaiting device validation.** Merged in PR #19 — `src/trends/aggregate.ts` +
`src/hooks/use-trends.ts` replace the `TRENDS` constant with real `store.readSince` aggregates — see
`docs/features/trends.md`. Both gates are met by tests: an empty state renders when no history
exists (simulated source and empty-store cases, `trends-screen.test.tsx`), and rendered values match
hand-computed aggregates on a seeded store (133/61/200/131 bpm — current/min/max/avg — in the same
suite). No device run yet.

### M8 — Background sensing
Android foreground service runs polling + accelerometer fold with the screen off. Gate: phone in pocket, screen off 30 min → buffer full on resume; a mattress drop triggers the fall rule.

### M9 — User profile and vulnerability tier
Age band, chronic-condition flag, outdoor-worker flag adjust thresholds and notification urgency. Gate: a profile with no flags reproduces today's outputs exactly (regression test).

**Status: profile capture done; threshold personalisation pending sign-off.** The capture half
(age band, chronic condition, outdoor worker, pregnant — Settings "About you") is built on
PR #7 (merged to master) — see `docs/features/user-profile.md`. The
regression gate above is already met by a dedicated test (a filled-in profile reproduces identical
Dashboard output). The threshold/notification-urgency half of this milestone is explicitly deferred
per ADR-005 pending a health-methodology review — see `docs/PROJECT_STATUS.md` "Decisions awaiting
human sign-off".

### M10 — 7-day personal baselines + Tier-2 anomaly score
Baselines from the store feed cardiovascular/fatigue rules; an explainable statistical anomaly score (EWMA/z-score against the user's own history) fuses into the engine. Gate: score is explainable in the card ("HR is 2.4σ above your usual at rest"); a written validation note accompanies it — no TFLite unless it earns its place over the statistical baseline.

### M11 — Hindi UI
i18n scaffolding, all Dashboard/SOS/Settings strings translated by a native speaker. Gate: language toggle works; no untranslated strings on the primary flows.

### M12 — Pilot-readiness hardening
Encrypted storage (`expo-secure-store` for contacts), onboarding that survives permission denial, a measured battery budget, Play Store health-permission approval, Maestro/Detox E2E, a written validation note per clinical threshold. Gate: an installable app a real family or ASHA cluster could run for a season-long pilot.

---

## Phase → milestone mapping

- **Phase 1 (now → ~2 weeks):** M1–M7.
- **Phase 2 (~weeks 3–6):** M8–M11.
- **Phase 3 (3–6 months):** M12, plus HealthKit/iOS, ESP32/BLE if hardware exists, crash reporting without PII.
- **Phase 4 (6–18 months, SCALE):** an aggregates-only backend (k-anonymity/differential privacy) for ASHA/district dashboards, official IMD/CPCB/NDMA feeds, multi-language, accessibility. This phase is contingent on a public-health program partnership — it is not planned as a self-funded, consumer-app rollout.
