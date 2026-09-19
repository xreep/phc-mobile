# Prototype audit — PS 26181 Personal Health Companion

**Date:** 2026-09-19 · **Audited state:** `master` @ `d0a7669` (PR #2 merged) + `eas.json` on `feat/health-connect-ingestion` · **Evidence:** the code in `phc-mobile/src` (13.7k lines), its 1084 passing tests, `PRD.md`, and the Problem Statement.

Legend used throughout: **BUILT NOW** · **PARTIALLY BUILT** · **NEXT** · **FUTURE**

---

## A. What is already built

| Component | Status | What it does (from the code) | PS alignment | Quality / completeness |
| --- | --- | --- | --- | --- |
| App shell (5 tabs: Dashboard, Trends, Environment, Community, Settings) | 🟢 Done | Expo Router tabs, theming, splash, web variants | §7 dashboard | Solid; screen tests exist |
| Tier-1 rule engine `src/risk/` | 🟢 Done | Pure, clock-free engine. 6 categories: heat (NOAA heat index bands), respiratory (SpO₂ <92 / <85 critical), cardiovascular (tachy >120 sustained-at-rest w/ hysteresis, brady <40), fall (impact + free-fall clause → stillness), dehydration (HR drift under heat), fatigue (inactivity + elevated HR). Scores 0–100, tiered guidance, `envMultiplier` reported, `criticalRules` handoff | §2 anomaly detection, §3 heat, §6 falls | Best module in the repo: ~600 tests, plausibility gates, staleness bounds, four historical "unsatisfiable threshold" bugs documented and pinned |
| Personal baselines `risk/baseline.ts` | 🟡 Partial | Each vital vs its rolling mean over the same 10-min window; "+16%" on the vitals row | §1 "track changes in baseline patterns" | Real but short-horizon: a 10-minute window is not a personal baseline |
| Environment module `src/environment/` | 🟢 Done | Coarse location → OpenWeatherMap weather + air-pollution → EPA AQI; validated offline cache; 30-min refresh + foreground catch-up; no prompt from background | §4 environmental awareness | Good; well tested incl. failure paths. AQI is **displayed but not scored** (see B) |
| Health Connect ingestion `src/sensors/` + `hooks/use-sensors.ts` | 🟡 Partial | Reads HR / SpO₂ / skin-temp (baseline+delta) every 60 s over the full retention window; folds the phone accelerometer at 25 Hz into a per-minute `MotionSummary`; ring buffer sized from the engine's own `longestLookbackMs`; user-only permission prompts | §1 continuous monitoring, §8 wearables | Built and unit-tested (with mocked native modules). **Not yet run on a device.** Foreground-only — polling stops when the app is backgrounded |
| Source gating (Settings picker) | 🟢 Done | `simulated` (default) keeps the demo window; `health_connect` goes live; `ble_esp32` is a label only | §8 | Correct; the mock cannot render under a Health Connect label (tested) |
| Emergency SOS `src/sos/` | 🟢 Done | State machine with 30-s cancel window, vibration, GPS fix, message composer, Twilio via a serverless relay (no credentials in the app), per-contact native SMS composer fallback, consent gate | §6 SOS, location | Well designed and tested (600+ lines of tests). Relay not deployed (`EXPO_PUBLIC_TWILIO_SOS_URL` unset) → composer path only |
| Settings persistence `src/settings/` | 🟢 Done | Contacts (E.164 normalised), name, sharing prefs (all off except SOS), sensor source; versioned key, validate-on-read | §5 user control over data | Good. Stored in **plain AsyncStorage**, not encrypted |
| Dashboard feed notice + SOS vitals | 🟢 Done | Explains empty live feed (permission / unavailable / waiting); SOS message quotes newest vitals | §6, §7 | Done this week; integration-tested |
| Dev "simulate a fall" | 🟢 Done (dev only) | Splices a real impact-then-stillness motion sequence into the buffer (mock or live); the engine detects it | Demo aid | Honest: proves the detector, not the card |
| Preparedness advisories `src/advisories/` | 🟢 Done | Static flood/cyclone guidance, explicitly unattributed to any agency | §3 flood/cyclone advisories | Static by design; no trigger from weather |
| Community summary `src/community/` | 🟡 Partial | Opt-in anonymised ward tally with k-anonymity floor — **fed by a hardcoded demo cohort**, labelled "Concept demonstration" | §8 public-health programs | Honest mock; no real data path |
| Trends screen | 🔴 Placeholder | Renders hardcoded `TRENDS` constants (`constants/health-data.ts`) | §7 trend analysis, §1 sleep | Looks functional, is static. Nothing persists readings |
| Reading persistence / encrypted DB | 🔴 Missing | No SQLite/SQLCipher; no reading is ever written to disk | §5 privacy (PRD says encrypted local DB) | — |
| Notifications / background operation | 🔴 Missing | No local or push notifications; no foreground service; JS timers suspend when backgrounded | §2 "real time", §6 automatic detection | Alerts exist only while the app is open on screen |
| Tier-2 ML (TFLite) | 🔴 Missing | `score`/`envMultiplier` are shaped for fusion; no model, no inference | §2 "on-device AI inference" | — |
| Sleep tracking | 🔴 Missing | No `SleepSession` read; no sleep rule | §1 sleep quality | — |
| User profile / vulnerability tier | 🔴 Missing | No age, conditions, outdoor-worker flag; every user scored identically | §3 "high-risk notifications for vulnerable individuals" | — |
| ESP32 / BLE adapter | 🔴 Missing | Picker option only | PRD §6.2 hardware demo | — |
| iOS / HealthKit | 🔴 Missing | Explicitly out of scope this phase | §8 | — |
| Localisation (Hindi) | 🔴 Missing | English only | PRD NFR | — |
| Official alert feeds (IMD/NDMA/CPCB) | 🔴 Missing | Deliberately not faked | §3 | — |

**Genuinely implemented:** rule engine, environment feed, SOS flow, settings, HC adapter + hook, dashboard wiring.
**Partial:** baselines (short window), community (demo data), HC (not device-validated, foreground only).
**Placeholder:** Trends screen.
**Functional but needs validation:** the entire Health Connect path (permissions on Android 14 vs 15, `SkinTemperature` availability, sideloaded-app permission visibility), SMS composer on a real device, Twilio relay.
**Should be redesigned:** Trends (must read a persisted history); alerts (must survive the app being backgrounded); the mock `TRENDS` and `VITALS` constants should die once persistence exists.

---

## B. PS requirement vs current prototype

| PS requirement | Current implementation | Gap | Priority | What we should do |
| --- | --- | --- | --- | --- |
| 1a Monitor HR, SpO₂, body temp | 🟡 HC adapter reads HR, SpO₂, skin temp (needs baseline) | Not device-validated; foreground only | P0 | Run the EAS dev build; validate with HC Toolbox; add a foreground service for polling |
| 1b Activity levels | 🟡 Accelerometer fold (peak/min/rms) for stillness/falls | No steps/activity metric shown to the user | P2 | Read HC `Steps`; show "active minutes" |
| 1c Sleep quality | 🔴 None | — | P2 | Read HC `SleepSession`; a fatigue input, not a new category |
| 1d Track baseline changes | 🟡 10-min rolling mean | No day/week baseline; no persistence | P1 | Persist readings; compute 7-day resting-HR / SpO₂ baseline; feed cardiovascular + fatigue rules |
| 1e Personalised wellness indicators | 🟡 Tiered guidance per category | Not personalised to the person | P1 | User profile (age band, conditions, outdoor worker) → threshold/score adjustments |
| 2a Abnormal HR patterns | 🟢 Tachy (sustained, at rest, hysteresis) + brady | — | — | Keep |
| 2b Heat stress / dehydration / fatigue / respiratory | 🟢 All four rules exist | Respiratory ignores AQI | P0 | Wire `aqi` into the respiratory multiplier (the field is already reserved) |
| 2c Sudden changes needing attention | 🟢 Critical rules → SOS candidate | Only while app is open | P0 | Notifications + background |
| 2d Risk assessment via on-device AI inference | 🟡 Deterministic rule engine, on-device, fusion-ready | No learned component | P1 | Tier-2: on-device personal-baseline anomaly score (statistical first, TFLite if it earns its place) |
| 3a Heat-wave warnings | 🟢 NOAA bands from live weather; guidance ladder | — | — | Keep |
| 3b Air-quality / respiratory alerts | 🟡 AQI shown on Environment screen | Not a risk input, no alert | P0 | Same as 2b |
| 3c Flood / cyclone advisories | 🟡 Static preparedness cards | Not triggered by conditions | P2 | Trigger card prominence from OWM alerts / rain; keep unattributed |
| 3d High-risk notifications for vulnerable individuals | 🔴 None | No profile | P1 | Profile → vulnerability multiplier → earlier notifications |
| 4 Environmental awareness | 🟢 Temp, humidity, AQI, coarse location, cache | CPCB not used (OWM air pollution instead) | P2 | Fine for MVP; note the source honestly |
| 5a All analysis local | 🟢 Engine, SOS decision, env fusion all on device | — | — | Keep; say it loudly |
| 5b Minimise transmission | 🟢 Only env requests (coarse loc) + SOS SMS leave the device | — | — | Keep |
| 5c Works offline | 🟡 Engine + cached env work offline; HC is local | No persisted history; SMS fallback untested on device | P1 | Persist; test airplane-mode flow |
| 5d User control over sharing | 🟢 Sharing prefs, consent gate on SOS | Settings unencrypted | P2 | Encrypt settings (expo-secure-store for contacts) |
| 6a Automatic fall / distress detection | 🟡 Fall rule + real accelerometer fold | Foreground only → a real fall with the phone in a pocket is **not** detected | P0 | Foreground service + wake lock, or Android `BODY_SENSORS`/step-style background path |
| 6b SOS to contacts | 🟢 Twilio relay + native SMS fallback | Relay not deployed | P0 | Deploy the Twilio Function (doc exists); demo with a second phone |
| 6c Location-enabled | 🟢 Precise GPS only on SOS | — | — | Keep |
| 7a Daily summaries / trends | 🔴 Static | — | P1 | After persistence: 24 h / 7 d from SQLite |
| 7b Risk scores heat/resp/cardio | 🟢 Plus fall, dehydration, fatigue | — | — | Keep |
| 7c Recommendations (hydration, rest, activity, consult) | 🟢 Tiered ladders per category | — | — | Keep |
| 8 Phones, watches, bands, healthcare wearables | 🟡 Any HC-writing band via Health Connect | No BLE/ESP32, no iOS | P2/P3 | ESP32 only if hardware exists; iOS post-SIH |

**How much of the PS is genuinely addressed?** Of the 8 expected-solution areas: **3 are covered** (environmental awareness, privacy-preserving local processing, SOS/location), **4 are half-covered with a real engine behind them but a missing input or output** (continuous monitoring — not validated/background; anomaly detection — no AQI input, no learned tier; disaster alerts — heat yes, air/flood partial; dashboard — no history), and **1 is nominal** (scalable deployment). The honest summary: *the decision layer is strong and tested; the sensing layer is new and unproven on hardware; the persistence and notification layers do not exist.* Roughly half the PS is demonstrable today, and the half that is missing is plumbing, not research.

---

## C. Current architecture audit

### What is good
- **The engine is pure.** `src/risk/` imports no React, no RN, no clock. Every rule is a function of `(readings, environment, now, thresholds)`. This is why it has 600 tests and why the same code runs in Jest and on the phone unchanged.
- **Ingestion is separated from judgement.** `SensorReading` is one schema; adapters map into it; the engine never sees Health Connect types. Adding BLE is an adapter, not a rewrite.
- **Provider-per-feed with a single source of truth.** Environment, Settings, Sensors are each one provider; two screens cannot disagree about the current observation.
- **Privacy is structural, not a checkbox.** No server holds vitals; the Twilio relay holds the credentials so the APK cannot leak them; coarse location for weather, precise only on SOS; consent gate persisted; no vitals logging anywhere in the code.
- **Failure paths are first-class.** Env cache-first with `status: 'cached'`; HC read failure keeps the buffer and still emits motion; SOS falls back per-contact; the engine reports `dataQuality: missing/stale/partial` instead of guessing.
- **Testing discipline.** Fake-timer tests pin AppState boundaries on both sides; "unsatisfiable threshold" bugs are pinned with cadence-aware tests; the live-shaped-buffer engine fix was probed before and pinned after.

### What is weak
- **Foreground-only sensing.** The polling hook and the accelerometer fold live in React effects. Android suspends JS timers in the background; the app detects nothing with the screen off. For a fall detector this is the difference between a feature and a demo.
- **No persistence at all.** The ring buffer is React state. Kill the app and the last 20 minutes are gone; Trends is a constant; baselines cannot exceed the buffer.
- **AQI is dead weight in the engine.** `EnvironmentSnapshot.aqi` is "reserved"; the respiratory rule never reads it, so the PS's air-quality alert is a screen, not a risk.
- **No output channel besides the screen.** No local notifications; an amber/red card the user is not looking at is not an "early warning".
- **"AI" is a rule engine.** Defensible (see J), but the `score`/`envMultiplier` fusion hooks have had no consumer for weeks; a judge will notice the TFLite line in the PRD.
- **Settings in plaintext AsyncStorage.** Contacts and name are low-sensitivity, but the PRD promises SQLCipher and the PS says "secure".
- **Line-ending hygiene.** Several files are CRLF, others LF; no `.gitattributes`. Cosmetic until a Windows teammate produces a 13k-line diff again.
- **Skin-temperature dependency on HC 1.1.** `readRecords('SkinTemperature')` on older Health Connect may throw; the hook would report `error` every poll. Unverified until the device run.
- **Community module is a mock in production code.** Labelled honestly, but a judge who taps it sees fabricated ward numbers.

### What should change now (hard later, easy now)
1. **Introduce a reading store (expo-sqlite) between the hook and the engine.** Every later feature — Trends, daily summaries, 7-day baselines, Tier-2 — reads from it. Retrofitting persistence after Trends/baselines are built against in-memory state means rewriting them.
2. **Move sensing out of React.** A headless "sensor service" module (started by a foreground service on Android) that writes to the store; the hook becomes a subscriber. Doing this after more UI is stacked on `useSensors` is painful.
3. **Add a user profile now, even if it is three fields.** Age band, chronic-condition flag, outdoor-worker flag. Thresholds and notification urgency will be personalised on it; every rule that is written before it exists will need touching.
4. **Wire AQI into the respiratory rule** before anyone builds an "air-quality alert" screen on top of a number the engine ignores.

---

## D. Development trajectory

| Phase | Features | Technical work | Risk | Expected outcome |
| --- | --- | --- | --- | --- |
| **1 — Current → stable MVP** (now → ~2 weeks) | Live HC readings verified on a phone; AQI→respiratory; local notifications for amber/red/critical; persisted readings; real Trends (24 h/7 d); deployed Twilio relay | EAS dev build + HC Toolbox validation; `expo-notifications`; `expo-sqlite` store + migrations; Trends from store; Twilio Function deploy | HC permission quirks on Android 14; foreground-only sensing remains | An honest end-to-end demo on real hardware with an SMS arriving on a second phone |
| **2 — MVP → strong SIH prototype** (~weeks 3–6) | Background sensing (foreground service) so falls are caught with the screen off; user profile + vulnerability tier; 7-day personal baselines; Tier-2 on-device anomaly score; Hindi UI; daily summary card; flood/cyclone cards triggered by weather | Android foreground service module (Expo config plugin or `expo-task-manager`/custom native); profile schema; baseline computation from the store; a small statistical/TFLite anomaly model with a documented validation; i18n | Native work is the riskiest item; ML validation story must be honest | A prototype that watches you while the phone is in your pocket, personalises risk, and can say what "AI" means |
| **3 — Prototype → production-ready** (3–6 months) | Encrypted store (SQLCipher / secure-store for contacts); HealthKit; ESP32/BLE adapter if hardware matters; caregiver companion (SMS-first); robust permission/onboarding flows; battery profiling; crash reporting without PII | Security review; store encryption + key in Keystore; adapter for iOS; Detox/Maestro E2E; Play Store health-permission compliance (Health Connect policy declaration) | Play Store review for health permissions is slow; clinical-claim wording | An installable app real families could run for a pilot |
| **4 — Production → scale** (6–18 months) | Opt-in anonymised aggregate for ASHA/district dashboards; official IMD/CPCB/NDMA feeds; multi-language; accessibility; device-tier coverage | A minimal backend for *aggregates only* (k-anonymity, differential privacy); partnerships for alert feeds; fleet config; observability | Government data partnerships; DPDP compliance at scale; support burden | City/state pilots via public-health programs; national only via a government partner, never as a startup-style consumer launch |

**Phase 1 — fix first:** device validation, AQI wiring, notifications, persistence, relay deployment.
**Phase 2 — add:** background sensing, profile, long baselines, an honest Tier-2, Hindi.
**Phase 3 — change for real users:** encryption, iOS, onboarding, compliance, E2E tests.
**Phase 4 — for city/state/national:** aggregates-only backend with privacy guarantees, official feeds, partnerships; the on-device core does not change.

---

## E. Future of the prototype

- **Next 1 month:** Everything in Phase 1 plus background sensing. The app goes from "scores a simulated window" to "watches a real band, persists history, notifies, and texts a contact". No new science — plumbing and validation.
- **Next 3 months:** Profile-personalised thresholds; 7-day baselines; a Tier-2 anomaly score that is *explainable* (deviation from the user's own baseline) rather than a black box; Hindi; daily summaries; a caregiver SMS test with 5–10 real users (family) for a week — the first real-world data on false-positive rates.
- **Next 6 months:** A serious pilot needs: encrypted store, a battery budget (<5 %/day measured), an onboarding flow that survives permission denial, Play Store health-permission approval, an ESP32/low-cost band story for users without a smartwatch, and a written validation of every threshold against literature. Pilot with one ASHA cluster or one outdoor-worker cohort (heat) — 50 users, one season.
- **Next 1 year:** Real deployment means a public-health partner, an aggregate-only backend, alert-feed integration, and a clear "this is a risk-awareness tool, not a diagnostic device" regulatory position (CDSCO SaMD guidance). The consumer-app path alone will not reach the PS's target users (rural, elderly, outdoor workers); the program path will.

---

## F. What we should NOT build

| Feature | Why it sounds useful | Why we should avoid it now |
| --- | --- | --- |
| LLM health chatbot / "ask the AI" | Demo-friendly, sounds like AI | Needs cloud or a huge on-device model; contradicts the privacy/offline story; unvalidatable medical advice; judges will ask what happens when it hallucinates |
| Deep-learning TFLite model trained on WESAD/PPG-DaLiA | The PRD lists it; "real ML" | Those datasets are 700 Hz lab PPG/EDA, not once-a-minute Health Connect samples — the model would be trained on data shaped nothing like ours. Build a personal-baseline anomaly score first; graduate to TFLite only if it beats it |
| Custom PCB / miniaturised wearable | Hardware credibility | Weeks of work, no runtime, doesn't change the software; the ESP32 breadboard is enough *if* a teammate already has parts |
| ECG / blood pressure / glucose | Broader medical coverage | No sensor source in scope; every added vital is another unvalidated threshold |
| Cloud backend with a web dashboard | Looks complete | Directly contradicts "all analysis on device"; invites "where is my data?" attacks |
| Federated learning / differential privacy for model training | Cutting-edge privacy | Solves a problem we do not have (there is no model being trained on user data); huge complexity |
| Blockchain health records | Buzzword | No requirement, no benefit, guaranteed hostile question |
| Disease-outbreak prediction | In the PS background | Population epidemiology from N=1 phone data is not credible; it needs the aggregates backend and a public-health partner |
| Live IMD/NDMA/CPCB integration | Official sources | No public API access today; a faked feed would be a live lie on stage — keep advisories unattributed and say why |
| Full multi-language localisation | Accessibility | i18n plumbing + Hindi is one sprint; ten languages is a translation project, not engineering |
| Caregiver companion app | Nice UX | A second app to build, sign, and demo; the SMS with a maps link already reaches the caregiver |
| Real-time streaming to a doctor | Impressive | Privacy contradiction, clinical liability, needs backend |

---

## G. AI / human work split for the remaining development

**AI coding tools can safely accelerate**
- The SQLite reading store (schema, migrations, read/write functions) — verify with the existing engine tests re-pointed at the store and a round-trip test after app restart.
- Trends screen fed from the store; daily-summary aggregation — verify against hand-computed values on a seeded DB.
- AQI → respiratory multiplier and the tests that pin the bands — verify the band boundaries against the EPA table already in `environment/aqi.ts`.
- `expo-notifications` wiring and the "notify on level change, not on every tick" logic — verify on a device that notifications are not spammed and that a critical one arrives while backgrounded.
- User-profile schema, settings UI, and threshold adjustments — verify that a profile with no flags reproduces today's outputs exactly (regression tests).
- i18n scaffolding and Hindi string extraction — a native speaker verifies the strings.
- E2E test scaffolding (Maestro flows) — humans record what a pass looks like.

**Humans must decide**
- Every clinical threshold and any change to one (SpO₂ 92/85, HR 120/40, heat-index bands, stillness durations) and its literature source.
- What "vulnerable" means in the profile and how much it shifts thresholds.
- Whether Tier-2 is a statistical baseline score or a trained model, and what validation claim the team is willing to defend on stage.
- The demo script, the honesty labels ("simulated", "concept demonstration"), and what is *not* claimed.
- Whether background sensing is done via a foreground service (visible notification, battery) — a product decision, not a coding one.

**Human validation required**
- The Health Connect path on at least two phones (Android 14 and 15): permission dialog, sideloaded-app visibility, `SkinTemperature` availability, batch-sync latency from a real band.
- SOS end to end: relay deployed, SMS received on a second phone, maps link opens, composer fallback in airplane mode.
- Fall detection with a real drop onto a mattress, phone in pocket, screen off — after background sensing lands. Record false positives over a normal day.
- Battery drain over 24 h with polling + accelerometer on.
- Every AI-generated test: read it and confirm it would fail if the feature were removed (the plan already caught two brief-authored tests with wrong expectations).

---

## H. Testing & validation gaps

**Present and strong:** engine rules and boundaries (fake-cadence aware); env fetch/cache/failure; SOS machine/message/delivery; hook AppState/timer/unmount discipline; HC mappers (never-0); screen integration with seeded settings.

**Missing**
- *Integration on real native modules:* no test has ever touched real Health Connect or a real accelerometer (all mocked). Permission-denied → retry → granted flows on device.
- *Background behaviour:* nothing tests what happens when the app is backgrounded for 30 minutes (answer today: nothing runs).
- *Persistence:* none, because there is no persistence.
- *E2E:* no Maestro/Detox; the screen tests are RNTL unit-level.
- *Edge cases:* clock skew between band and phone (future-stamped samples are dropped by `withinWindow` — untested on live data); DST; a band that writes HR at 1 Hz (buffer size, `mergeReadings` cost); duplicate records across overlapping reads at scale.
- *Failure:* `SkinTemperature` unsupported → `Promise.all` rejects every poll (unverified); OWM rate-limit/401; Twilio relay 5xx at scale; SMS composer unavailable (tablet).
- *Security:* relay abuse (documented, untested); settings tampering; no static analysis for PII logging.
- *AI/model validation:* no false-positive/false-negative measurement of any rule on real data; no validation doc per threshold.
- *Offline:* engine offline is implicit; an airplane-mode manual test of the whole SOS path has not been recorded.
- *Performance/battery:* none.

**Prioritised testing plan**
1. **Device smoke (P0):** EAS build → HC Toolbox → insert HR 78 / SpO₂ 97 → vitals row; insert SpO₂ 84 twice → SOS countdown → SMS on a second phone. Record on video; this is the demo rehearsal.
2. **HC compatibility matrix (P0):** Android 14 and 15; grant/deny each permission; note whether `SkinTemperature` appears; fix the request set if it throws.
3. **Airplane-mode SOS (P0):** relay unreachable → composer opens pre-filled per contact.
4. **Background test (P1, after foreground service):** screen off 30 min with a band writing → buffer full on resume; fall with phone in pocket.
5. **False-positive day (P1):** one team member wears a band for a normal day; count amber/red cards; tune only with a written reason.
6. **Persistence round-trip (P1):** kill app → reopen → Trends shows the last 24 h.
7. **Battery (P2):** 24 h with polling + accelerometer; target <5 %.
8. **Maestro E2E (P2):** Settings → source switch → permission → Dashboard notice → SOS cancel.

---

## I. Current demo vs ideal demo

**Current demo (today, without a build):** Simulated vitals window; *live* weather/AQI for the phone's city (heat card is real); risk cards computed by the real engine; tap "Dev · Simulate a fall" → fall card red → SOS countdown → cancel or send → SMS composer opens pre-filled (no relay). Community and Trends screens are static.

**Weak points**
- The subtitle says **"Simulated data"** — a judge will read it.
- Trends looks live and is a constant; one question exposes it.
- AQI is on the Environment screen but the respiratory card does not react to it — a judge in Delhi will ask.
- The fall is a button; the room knows it.
- If the SOS relay is not deployed, "the SMS app opens" looks like a manual step.
- Nothing happens if the phone is locked — "so it only works while I stare at it?"

**Ideal SIH demo**

```text
Problem
  "In a heat wave, an outdoor worker's HR climbs and SpO₂ drops for an hour before anyone notices."
 ↓
User interaction
  Presenter wears a band (or a second phone runs HC Toolbox); the app is set to Health Connect.
  Dashboard shows live HR/SpO₂ with "Updated 20s ago · Android Health Connect".
 ↓
System processing
  Live weather for the venue city → heat index band; accelerometer fold shows "at rest".
  A low SpO₂ (90 → 84 → 84) is written to Health Connect (Toolbox, or breath-hold with a real oximeter band).
 ↓
AI / rules / backend
  On-device engine: respiratory flag → critical after two confirmed samples; envMultiplier from heat;
  no network involved — presenter toggles airplane mode to prove it.
 ↓
Real-time result
  Card turns red with plain-language guidance; local notification fires on the lock screen;
  30-second SOS countdown starts with cancel.
 ↓
Action / alert / recommendation
  Countdown lapses → SMS with vitals + maps link arrives on the judge's phone (relay) —
  or, in airplane mode, the composer opens per contact.
 ↓
Impact
  "Detected in under two minutes, no cloud, no data left the phone except the SOS. The same engine runs
   heat, dehydration, fatigue and falls; here is the fall detector on a real drop."
```

---

## J. Judge attack test (based on what exists)

| Judge question | Strong answer | Evidence | Likely follow-up | Best response |
| --- | --- | --- | --- | --- |
| "Is this actually AI?" | Today it is a deterministic on-device risk engine fusing six physiological rules with environmental context; the scores and multipliers are designed to fuse with a learned tier, which we have deliberately not shipped until we can validate it. | `risk/assess.ts` scores + `envMultiplier`; 600 rule tests; PRD §7.2.2 tiers | "So no machine learning?" | "Not yet in the build. Our next tier is a personal-baseline anomaly score — learned from the user's own history on device. We chose validated thresholds first because a wrong ML alert in a disaster is worse than none." |
| "Where did your data come from?" | Vitals from Health Connect (any band); weather/AQI from OpenWeatherMap by coarse location; thresholds from NOAA heat index, WHO/AHA SpO₂ and HR guidance cited in `risk/config.ts`. | `config.ts` comments; `environment/openweather.ts` | "Have you tested on real people?" | "We have validated the sensor path on our phones with Health Connect; a wear-for-a-day false-positive study is the next step and we know that number is what matters." |
| "What happens when the API fails?" | Weather: last-known-good cache with a 'cached' badge, staleness bounded at 60 min after which the heat rule reports 'stale' instead of judging. SOS: relay failure or timeout falls back per contact to the SMS composer. Health Connect read failure keeps the buffer and still records motion. | `use-environment.ts`, `sos/deliver.ts`, `use-sensors.ts` tests | "And with no signal at all?" | "The engine never needed the network; SOS uses SMS which needs only a cell tower — that is why Twilio is a relay, not the only path." |
| "Why this architecture?" | Pure engine, adapters into one schema, one provider per feed, nothing sensitive leaves the device. It let us test 1000+ cases without a phone and swap the mock for Health Connect with a one-line change. | `risk/index.ts` header; `useRiskAssessment` | "Why not a backend?" | "The PS asks for on-device; a backend would be an attack surface and a dependency during the exact outages we target. The only server is a credential relay for SMS." |
| "How do you know your prediction is accurate?" | Each threshold is sourced and the rules require *sustained* evidence (two SpO₂ samples, 10 minutes of tachycardia at rest) to cut false alarms; the 30-second cancel absorbs the rest. We measure staleness and data quality per category and say 'unknown' instead of guessing. | `dataQuality`, `criticalConfirmations` | "What is your false-positive rate?" | "Unmeasured on a population — we will not quote a number we did not measure. Our plan is a 10-person, one-week wear study." |
| "What is novel?" | Not a single sensor or model — the fusion of personal vitals with local disaster context on device, with a safety-graded output (advisory → flag → critical → SOS) that works offline. Most consumer apps stop at 'your HR is high'. | Heat×stillness rule; dehydration drift under heat | "Fitbit does HR alerts." | "Fitbit does not know it is 44 °C outside, does not text your family with a location, and needs its cloud." |
| "What stops someone building this easily?" | Nothing stops a big company; what we have that they do not ship is the disaster-context fusion, offline-first SOS, and a privacy posture aligned with DPDP. The moat is the public-health program path, not the app. | — | "So why you?" | "Because we are building for ASHA workers and outdoor labourers, not for a subscription." |
| "Can this scale?" | On device it scales per phone. Programs need only an opt-in *aggregate* path, which the community module prototypes with k-anonymity — nothing per-person ever leaves. | `community/aggregate.ts` k-floor | "That screen is fake." | "Yes — labelled 'concept demonstration'. It shows the shape of what a district sees; the data path is Phase 4." |
| "What happens in a real emergency?" | Critical rule → vibration + 30-s cancel → SMS with vitals and a maps link to every contact; works with cell signal only. | `sos/machine.ts`, `message.ts` | "And if the phone is in a pocket, screen off?" | Honest: "Today the sensing runs only while the app is open — background sensing via a foreground service is our top engineering item and we know it is the gap." |
| "What if the model is wrong?" | Every alert is advisory with plain guidance; only 'critical' escalates, and it can be cancelled in 30 s. We never auto-call services. Wrong-green is the risk we mitigate with 'data quality: missing' rather than a confident green. | `DataQuality` doc in `types.ts` | "Wrong-red during a flood?" | "One unnecessary SMS to a family member. That asymmetry is designed in." |
| "Why isn't an existing solution enough?" | Wearable apps are cloud-first, English-first, and blind to environment and disasters; government alert apps are one-way and not personal. Nobody combines the two on the device. | — | "Google Health Connect does it." | "Health Connect is a data store — we are the intelligence on top of it, and we use it precisely so users keep their existing band." |

---

## K. Exact next tasks

| Priority | Task | Why | Dependency | Definition of done |
| --- | --- | --- | --- | --- |
| 🔴 P0 | Link EAS, build the development client, install on the phone | Nothing in the sensing layer is validated | Expo account | APK installed; `Updated Ns ago · Android Health Connect` visible with a Toolbox HR record |
| 🔴 P0 | Health Connect compatibility pass (Android 14 + 15) | `SkinTemperature`/sideload quirks can break every poll | above | Permission sheet works on both; if `SkinTemperature` throws, request set drops it on unsupported HC; result recorded in `docs/health-connect.md` |
| 🔴 P0 | Wire AQI into the respiratory rule | PS 3b is a display, not an alert | — | `EnvironmentSnapshot.aqi` sets `envMultiplier` and an advisory rule at Unhealthy+; tests pin EPA band boundaries; Environment and Dashboard agree |
| 🔴 P0 | Local notifications on level change and on critical | Early warning that nobody sees is not a warning | `expo-notifications` | Amber→red and any critical fires one notification (debounced per category); verified on a locked phone |
| 🔴 P0 | Deploy the Twilio relay; end-to-end SMS test | Demo credibility | Twilio trial | SMS with vitals + maps link received on a second phone; airplane-mode composer fallback recorded |
| 🔴 P0 | `.gitattributes` + normalise line endings; merge `eas.json` | Prevent the next 13k-line diff | — | `* text=auto eol=lf`; one normalising commit; CI-free `git diff` is quiet |
| 🟠 P1 | Reading store on `expo-sqlite` (readings table, retention, migrations) and feed the hook from it | Prerequisite for Trends, baselines, Tier-2 | — | Readings survive app restart; engine reads from the store; existing tests green |
| 🟠 P1 | Trends from the store (24 h / 7 d min/avg/max, sparkline) and delete `TRENDS` constant | Placeholder screen | store | Screen shows real history; empty-state when none |
| 🟠 P1 | Background sensing: Android foreground service that runs polling + accelerometer fold | Falls and critical vitals with the screen off | native module / config plugin | Phone in pocket, screen off 30 min: buffer full on resume; a mattress drop triggers the fall rule |
| 🟠 P1 | User profile (age band, chronic condition, outdoor worker) → vulnerability multiplier and notification urgency | PS 3d | settings schema | Profile with no flags reproduces today's outputs (regression); flagged profile lowers heat/tachy thresholds per a documented table |
| 🟠 P1 | 7-day personal baselines (resting HR, SpO₂) from the store; cardiovascular + fatigue use them | PS 1d | store | Baseline row shows "vs your 7-day resting HR"; tests with synthetic weeks |
| 🟠 P1 | Tier-2 personal-baseline anomaly score (EWMA/z-score on device) fused via `envMultiplier`/score | Honest "AI inference" story | baselines | Score explainable in the card ("HR is 2.4σ above your usual at rest"); validation note in docs |
| 🟠 P1 | Hindi UI strings (i18n scaffolding) | PRD NFR; target users | — | Language toggle; all Dashboard/SOS/Settings strings translated by a speaker |
| 🟡 P2 | Sleep (`SleepSession`) and steps as fatigue/activity inputs | PS 1b/1c | HC path | Fatigue rule uses last night's sleep; activity minutes on Dashboard |
| 🟡 P2 | Flood/cyclone cards surfaced by weather alerts/rain, still unattributed | PS 3c | env module | Card moves to top under heavy-rain/wind conditions |
| 🟡 P2 | Encrypt settings/contacts (`expo-secure-store`) | PRD security | — | Contacts not readable from AsyncStorage dump |
| 🟡 P2 | Maestro E2E for the demo flow | Regression safety before stage | device build | Flow runs green on a device before each demo |
| 🟡 P2 | ESP32 BLE adapter (only if a teammate has the board) | PRD hardware fallback | hardware | `ble_esp32` source shows live HR from the board |
| ⚪ P3 | HealthKit adapter; caregiver app; aggregate backend; official feeds; CDSCO positioning | Post-SIH | — | — |

---

## L. Final current-state verdict

**1. Where we are now.** A well-engineered *decision layer* (rule engine, environmental fusion, SOS) with unusually strong tests, a brand-new *sensing layer* (Health Connect + accelerometer) that is unit-tested but has never run on a phone, and *no persistence, no notifications, and no background operation*. The prototype proves the reasoning; it does not yet prove continuous monitoring.

**2. Biggest current gap.** The app only senses while it is open on screen. For a PS whose headline outcomes are "before they become emergencies" and "automatic detection of falls", foreground-only sensing means the core promise is not yet demonstrable outside a staged demo.

**3. Highest-value next step.** Get the Health Connect build onto a phone and validate it end to end (readings → red card → SMS on a second phone). It costs a day, converts weeks of tested code into a real demo, and tells us whether the sensing layer works before we build persistence and background sensing on top of it.

**4. Long-term direction.** An on-device risk companion distributed through public-health programs (ASHA clusters, outdoor-worker cohorts) rather than an app-store product: Health Connect for sensing, an explainable personal-baseline tier as the "AI", SMS-first emergency reach, and an aggregates-only path for districts. The engine stays where it is — on the phone.

## 🚦 Development status

🟡 **Needs Major Work** — the foundation is genuinely aligned with the PS (on-device, privacy-first, disaster-aware, tested), and the remaining work is plumbing rather than research; but three PS-critical capabilities — device-validated live sensing, background operation, and persisted history/notifications — do not exist yet, and until the first of them is proven on a phone the prototype's strongest claims rest on a simulated window.
