# Roadmap

Derived from [`docs/prototype-audit-2026-09-19.md`](prototype-audit-2026-09-19.md) §D/§E. Milestones
are grouped into the phases the audit defines; M0–M12 are this document's own numbering of the
concrete steps inside those phases so each has a single, trackable name.

## Summary: NOW → NEXT → SIH-READY → PILOT-READY → PRODUCTION → SCALE

| Stage | State |
| --- | --- |
| **NOW** | Decision layer (rule engine, environment fusion, SOS logic) built and unit/integration tested. Sensing layer built but never run on a phone. No persistence, no notifications, no background operation. |
| **NEXT** | Device-validated sensing, AQI wired into risk, notifications, persisted readings, deployed SMS relay — an honest end-to-end demo on real hardware. |
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

### M4 — Local notifications
`expo-notifications` fires on risk-level change (amber→red) and on any critical rule, debounced per category. Gate: verified on a locked phone.

### M5 — Twilio relay deployed
End-to-end SMS test. Gate: SMS with vitals + maps link received on a second phone; airplane-mode composer fallback recorded.

### M6 — Reading store (`expo-sqlite`)
Readings persist across restarts; the hook reads from the store. Gate: existing engine tests stay green pointed at the store; a round-trip test survives an app restart.

### M7 — Real Trends
Trends screen reads 24 h / 7 d history from the store; the `TRENDS` constant is deleted. Gate: empty-state when no history exists; values match hand-computed aggregates on a seeded DB.

### M8 — Background sensing
Android foreground service runs polling + accelerometer fold with the screen off. Gate: phone in pocket, screen off 30 min → buffer full on resume; a mattress drop triggers the fall rule.

### M9 — User profile and vulnerability tier
Age band, chronic-condition flag, outdoor-worker flag adjust thresholds and notification urgency. Gate: a profile with no flags reproduces today's outputs exactly (regression test).

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
