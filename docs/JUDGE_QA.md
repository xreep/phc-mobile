# Judge Q&A

Honest answers, sourced from [`docs/prototype-audit-2026-09-19.md`](prototype-audit-2026-09-19.md) §J
(the only audit in this repository — no second audit document exists to draw a "both audits"
comparison from). Nothing here states an accuracy, false-positive, or battery figure that was not
measured. Health language stays to "risk indication" / "recommendation to seek help" — never
"diagnose".

---

### "What is actually working?"
**Honest answer today:** A deterministic on-device rule engine (6 categories: heat, respiratory,
cardiovascular, fall, dehydration, fatigue) scores either a simulated vitals window or a live
Health Connect buffer; live weather/AQI for the phone's coarse location feeds the heat rule; an SOS
state machine sends SMS via a Twilio relay or falls back to the native composer. All of this is
unit/integration tested. None of the sensing or SOS layers has run on a phone yet.
**Evidence:** `src/risk/`, `src/environment/`, `src/sos/`; 1084 passing tests.
**What changes after M1 (device validation):** the sensing and SOS paths move from "unit tested
against mocks" to "device validated."

### "What is simulated?"
**Honest answer today:** The default vitals source is a synthesised window (`constants/mock-sensor-window.ts`);
the Trends screen renders hardcoded constants (`constants/health-data.ts`); the Community screen is
fed by a hardcoded demo cohort (`community/demo-cohort.ts`), labelled "Concept demonstration." Weather
and AQI are real API data, not simulated.
**Evidence:** `src/constants/mock-sensor-window.ts`, `src/constants/health-data.ts`, `src/community/demo-cohort.ts`.
**What changes after M6/M7 (reading store, real Trends):** Trends reads persisted history instead
of a constant; the simulated window remains only as an explicitly labelled demo fallback.

### "Where is your AI?"
**Honest answer today:** Today it is a deterministic, on-device risk engine fusing six physiological
rules with environmental context — not a trained model. The score and `envMultiplier` outputs are
shaped for a learned tier we have deliberately not shipped until it can be validated.
**Evidence:** `src/risk/assess.ts`; ~600 rule tests; `PRD.md` §7.2.2 tiers.
**What changes after M10 (Tier-2 anomaly score):** an explainable, on-device, personal-baseline
anomaly score (deviation from the user's own history) fuses into the engine — a statistical model
first, TFLite only if it earns its place over the statistical baseline.

### "No internet?"
**Honest answer today:** The rule engine never needs the network. Weather/AQI use a last-known-good
cache with a "cached" badge, staleness bounded at 60 minutes, after which the heat rule reports
"stale" instead of judging. SOS falls back per-contact to the native SMS composer, which needs only
a cell signal, not data connectivity.
**Evidence:** `src/environment/cache.ts`, `src/sos/deliver.ts`.
**What changes after M5 (relay deployed):** an airplane-mode SOS test will be recorded on a device
instead of only unit-tested.

### "Phone locked?"
**Honest answer today:** Nothing runs today with the screen off — polling and the accelerometer
fold live in React effects, and Android suspends JS timers in the background. This is the single
biggest gap between the current prototype and the PS's "automatic detection" promise.
**Evidence:** `hooks/use-sensors.ts`; audit §C "What is weak."
**What changes after M8 (background sensing):** an Android foreground service keeps polling and the
accelerometer fold running with the screen off; a fall with the phone in a pocket becomes detectable.

### "How accurate?"
**Honest answer today:** Unmeasured. No accuracy, sensitivity, or specificity figure has been
computed against real or reference data, and none is claimed. Thresholds are sourced from public
guidance (NOAA heat index, WHO/AHA SpO₂ and HR bands) and require sustained evidence (e.g. two
confirmed SpO₂ samples, 10 minutes of at-rest tachycardia) before flagging, to reduce false alarms.
**Evidence:** `src/risk/config.ts` threshold comments.
**What changes after a wear study (post-M8):** a 10-person, one-week wear study is the planned next
step for a real false-positive count — no figure exists before that study runs.

### "How validated?"
**Honest answer today:** Unit and integration tests only (48 suites / 1084 tests). No device
validation, no real-world validation, for any sensing or SOS path. UI and live weather have been
observed working on an August APK build, against a simulated vitals window.
**Evidence:** `docs/testing/validation-levels.md`; `docs/PROJECT_STATUS.md` "Device Validated" section.
**What changes after M1–M2:** the sensing path is validated against a real Health Connect Toolbox
record on Android 14 and 15.

### "Why not Fitbit/Apple/Google?"
**Honest answer today:** Those apps do consumer HR/SpO₂ alerts well but do not fuse personal vitals
with local disaster context (heat index, AQI), do not text a family member with a location on a
critical event, and are cloud-dependent. Health Connect is used precisely so a user keeps whichever
band they already own, rather than needing our hardware.
**Evidence:** `src/risk/rules/heat.ts` (heat×stillness fusion); `src/risk/rules/dehydration.ts`.
**Follow-up ("Health Connect does this already"):** Health Connect is a data store; the app is the
intelligence layer on top of it.

### "Why on-device?"
**Honest answer today:** All physiological analysis and the SOS decision run on the phone; the only
network calls are coarse-location weather/AQI requests and the SOS SMS itself. A backend would be
an attack surface and an added dependency during exactly the outages the PS targets (disasters).
The only server that exists is a credential relay so the app never holds Twilio credentials.
**Evidence:** `src/risk/index.ts` header comments; `docs/security/privacy-architecture.md`.

### "Wrong warning?"
**Honest answer today:** Every alert is advisory with plain-language guidance; only "critical"
escalates to SOS, and that has a 30-second cancel window before anything is sent. A wrong "red" costs
one unnecessary SMS to a family member; a wrong "green" is mitigated by reporting `dataQuality:
missing/stale/partial` instead of a falsely confident score. We never auto-call emergency services.
**Evidence:** `DataQuality` in `src/risk/types.ts`; `src/sos/machine.ts` cancel window.

### "Government deployment?"
**Honest answer today:** Not attempted and not architected yet. The long-term direction is
distribution through public-health programs (ASHA clusters, outdoor-worker cohorts) with an
aggregates-only backend (k-anonymity / differential privacy) for district-level visibility — the
Community screen's real aggregation logic previews this shape but is fed by a hardcoded demo cohort
today, labelled "Concept demonstration." No government API integration exists; official IMD/NDMA/CPCB
feeds are deliberately not faked.
**Evidence:** `src/community/aggregate.ts` (k-anonymity floor); audit §F ("What we should NOT build" — live official-feed integration without access).
