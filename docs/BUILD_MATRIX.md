# Build matrix

One row per capability in the state matrix of [`docs/prototype-audit-2026-09-19.md`](prototype-audit-2026-09-19.md)
§A/§B. Status uses the same ladder as [`PROJECT_STATUS.md`](PROJECT_STATUS.md): **Built / Unit
tested / Integration tested / Device validated / Real-world validated / Mock-demo / Planned /
Blocked**. No accuracy, false-positive, or battery figures are included — none have been measured.

| Feature | Implemented | Tested | Device Validated | Real-World Validated | Status |
| --- | --- | --- | --- | --- | --- |
| App shell (5 tabs) | ✅ | ✅ | ❌ | ❌ | Integration tested |
| Rule engine — heat | ✅ | ✅ | ❌ | ❌ | Unit tested |
| Rule engine — respiratory | ✅ | ✅ | ❌ | ❌ | Unit tested (AQI not wired in) |
| Rule engine — cardiovascular | ✅ | ✅ | ❌ | ❌ | Unit tested |
| Rule engine — fall | ✅ | ✅ | ❌ | ❌ | Unit tested |
| Rule engine — dehydration | ✅ | ✅ | ❌ | ❌ | Unit tested |
| Rule engine — fatigue | ✅ | ✅ | ❌ | ❌ | Unit tested |
| Heart rate (Health Connect) | ✅ | ✅ | ✅ | ❌ | Device validated 2026-09-20 (Android 15, Toolbox record read within one poll) |
| SpO₂ (Health Connect) | ✅ | ✅ | ✅ | ❌ | Device validated 2026-09-20 (91 % → flag; 2×80 % → critical → SOS countdown) |
| Skin temperature (Health Connect) | ✅ | ✅ | ❌ | ❌ | Unit tested; `SkinTemperature` on HC <1.1 unverified |
| Accelerometer fold (`MotionSummary`) | ✅ | ✅ | ❌ | ❌ | Unit tested (mocked `expo-sensors`) |
| Fall detection (engine + motion) | ✅ | ✅ | ❌ | ❌ | Unit tested; demoed only via the dev "Simulate a fall" splice |
| Health Connect adapter (permissions, I/O) | ✅ | ✅ | ✅ | ❌ | Device validated 2026-09-20 (Android 15: all three permissions listed and granted) |
| Environment / weather (OpenWeatherMap) | ✅ | ✅ | 🟡 | ❌ | Live weather seen working on the August APK (simulated vitals); not a full device validation pass |
| AQI display (Environment screen) | ✅ | ✅ | ❌ | ❌ | Unit tested |
| AQI → risk (respiratory `envMultiplier` + advisory) | ✅ | ✅ | ✅ | ❌ | Device validated 2026-09-20 (local AQI 177 → Caution on real air-quality data) |
| Personal baselines (10-min rolling mean) | 🟡 | ✅ | ❌ | ❌ | Unit tested; partial — not a day/week baseline |
| Reading persistence (SQLite) | ✅ | ✅ | ❌ | ❌ | Built, unit/integration tested (M6, PR #17) — `expo-sqlite`, 7-day retention, erase control. Device validated: NO — new EAS build in progress. See `docs/features/reading-store.md` |
| Trends screen | ✅ | ✅ | ❌ | ❌ | Built, unit/integration tested (M7, PR #19) — real 24h/7d history from the reading store, `TRENDS` constant deleted. Device validated: NO. See `docs/features/trends.md` |
| Local notifications | ✅ | ✅ | ✅ | ❌ | Device validated 2026-09-20 after the foreground-handler fix (PR #14); foreground-only |
| Background sensing | ❌ | ❌ | ❌ | ❌ | Planned (P1) — polling and accelerometer fold stop when backgrounded |
| SOS flow (state machine, cancel window) | ✅ | ✅ | ✅ | ❌ | Device validated 2026-09-20: critical → vibration → 30-s countdown → SMS composer (fallback path). Relay dispatch now built (below) but not yet exercised in this flow on a device |
| Relay – Telegram | ✅ | ✅ (vitest, 142) | ✅ | ❌ | **Device validated 2026-09-21** — `/start <linkToken>` → `/link` → `/sos` delivered a real message to a real Telegram account in ~1 s. Deployed at `phc-sos-relay.xreep.workers.dev` |
| Relay – Textbelt SMS | ✅ | ✅ | ✅ | ❌ | **Blocked for India** — free tier answers "free SMS are disabled for this country due to abuse"; relay returns 502 as designed and the phone falls back to the composer |
| Relay – Twilio | ✅ | ✅ | ❌ | ❌ | Code kept, **disabled** — needs KYC + paid top-up for India-based accounts |
| Relay – FCM | ❌ | — | ❌ | ❌ | **Planned (M5 part 2)** — stub adapter only, needs the caregiver role in the app |
| App → relay dispatch (structured contract, Telegram linking) | ✅ | ✅ (Jest) | ✅ | ❌ | Built, unit/integration tested (PR #22) — `src/sos/relay.ts`, `src/sos/telegram-link.ts`; `twilio.ts` removed. Device validated: NO — on-phone test is next, pending the new EAS build |
| SMS composer fallback | ✅ | ✅ | ❌ | ❌ | Unit tested |
| Offline operation (engine + cached env) | ✅ | ✅ | ❌ | ❌ | Unit tested; airplane-mode SOS flow not run on a device |
| Personalisation (user profile / vulnerability tier) | ✅ | ✅ | ❌ | ❌ | Integration tested — merged to master (PR #7); capture only — proven no-op for risk thresholds, ADR-005 |
| Tier-2 on-device anomaly score | ❌ | ❌ | ❌ | ❌ | Planned (P1) — no ML in this build |
| Community aggregate (k-anonymity) | 🟡 | ✅ | ❌ | ❌ | Mock-demo — real aggregation logic, hardcoded demo cohort |
| Preparedness advisories (flood/cyclone) | ✅ | ✅ | ❌ | ❌ | Unit tested; static, not weather-triggered |
| Sleep tracking | ❌ | ❌ | ❌ | ❌ | Planned (P2) |
| Activity / steps | ❌ | ❌ | ❌ | ❌ | Planned (P2) |
| Hindi localisation | ❌ | ❌ | ❌ | ❌ | Planned (P1) |
| ESP32 / BLE adapter | ❌ | ❌ | ❌ | ❌ | Planned (P2) — picker label only, no adapter |
| Secure storage (settings/contacts) | ❌ | — | ❌ | ❌ | Planned (P2) — currently plaintext AsyncStorage |
| CI (lint/typecheck/test on push and PR) | ✅ | ✅ | — | — | Built, this branch |

**Legend:** ✅ done · 🟡 partial · ❌ not started.
