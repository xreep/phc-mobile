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
| Reading persistence (SQLite) | ❌ | ❌ | ❌ | ❌ | Planned (P1) |
| Trends screen | 🟡 | ✅ | ❌ | ❌ | Mock-demo — renders hardcoded `TRENDS` constants |
| Local notifications | ✅ | ✅ | ✅ | ❌ | Device validated 2026-09-20 after the foreground-handler fix (PR #14); foreground-only |
| Background sensing | ❌ | ❌ | ❌ | ❌ | Planned (P1) — polling and accelerometer fold stop when backgrounded |
| SOS flow (state machine, cancel window) | ✅ | ✅ | ✅ | ❌ | Device validated 2026-09-20: critical → vibration → 30-s countdown → SMS composer (fallback path; relay not yet deployed) |
| SMS relay (Twilio) | ✅ | ✅ | ❌ | ❌ | Unit tested; relay not deployed |
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
