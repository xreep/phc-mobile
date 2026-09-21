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
Health Connect buffer, now backed by a persisted 7-day reading store; live weather/AQI for the
phone's coarse location feeds the heat rule; the Trends screen reads real history from that store;
an SOS state machine posts to a deployed multi-channel relay (Telegram primary, SMS gateway
secondary) or falls back to the native composer. All of this is unit/integration tested, and the
relay's Telegram lane has additionally been device validated by hand (2026-09-21) — everything
else, including the store, Trends, and the app's own relay dispatch, has not yet run on a phone.
**Evidence:** `src/risk/`, `src/environment/`, `src/store/`, `src/trends/`, `src/sos/`; 63 suites /
1457 app tests, 142 relay tests.
**What changes after the next EAS build:** the store, Trends, and app-side SOS relay dispatch move
from "unit/integration tested against mocks" to "device validated."

### "What is simulated?"
**Honest answer today:** The default vitals source is a synthesised window (`constants/mock-sensor-window.ts`);
the Community screen is fed by a hardcoded demo cohort (`community/demo-cohort.ts`), labelled
"Concept demonstration." Weather and AQI are real API data, not simulated. Trends is no longer
simulated — it reads whatever is actually in the on-device reading store (M6/M7, merged); on the
simulated source, or with nothing stored yet, it says so honestly rather than showing a fixed chart.
**Evidence:** `src/constants/mock-sensor-window.ts`, `src/community/demo-cohort.ts`,
`src/trends/aggregate.ts`.
**What changes after device validation of M6/M7:** the same store-backed Trends screen moves from
"tested against mocks" to confirmed working against the real `expo-sqlite` driver on a phone.

### "Where is your AI?"
**Honest answer today:** Today it is a deterministic, on-device risk engine fusing six physiological
rules with environmental context — not a trained model. The score and `envMultiplier` outputs are
shaped for a learned tier we have deliberately not shipped until it can be validated.
**Evidence:** `src/risk/assess.ts`; ~600 rule tests; `PRD.md` §7.2.2 tiers.
**What changes after M10 (Tier-2 anomaly score):** an explainable, on-device, personal-baseline
anomaly score (deviation from the user's own history) fuses into the engine — a statistical model
first, TFLite only if it earns its place over the statistical baseline.

### "How does the SOS reach someone automatically?"
**Honest answer today:** Over any data connection the app posts the alert to a relay we run (a
Cloudflare Worker, deployed at `phc-sos-relay.xreep.workers.dev`); the relay delivers it on Telegram
to a caregiver who linked once by tapping a link from the app's Settings, and, when a number is on
file, also as an SMS through a gateway — neither needs a tap. The screen then reports per person,
e.g. "Sent to Meera via Telegram". With no data connection at all, the phone opens a pre-filled SMS
that needs one tap, because no consumer app on Android or iOS can send an SMS silently. The relay's
Telegram path has delivered a real message to a real phone (2026-09-21); the app's own dispatch and
linking are unit/integration tested against a mocked network and have not yet been exercised from a
phone.
**Evidence:** `relay/src/dispatch.ts`, `src/sos/relay.ts`, `src/sos/telegram-link.ts`;
`docs/features/sos-relay.md`.
**What changes after the next EAS build:** the app-side dispatch and linking move from "Jest-tested
against a mocked `fetch`" to "device validated," the same way the relay's Telegram lane already has.

### "Why Telegram and not SMS?"
**Honest answer today:** There is no free, global, KYC-free SMS service. We tried the two realistic
free options: Textbelt's free tier answered "free SMS are disabled for this country due to abuse"
for an Indian number (confirmed 2026-09-21 — the relay correctly reported failure and the app's
design falls back to the SMS composer), and Twilio requires KYC and a paid top-up for India-based
accounts, so it is kept in the codebase, disabled. Telegram bots are free, unlimited, and need no
KYC — a caregiver links once by tapping a deep link, and after that the relay can message them
indefinitely at no cost. SMS still runs alongside Telegram whenever a phone number is on file
(concurrently, not as an afterthought), because a locked-screen SMS notification is something a
data-only Telegram message cannot guarantee — the two channels cover different failure modes.
**Evidence:** `relay/src/adapters/textbelt.ts`, `relay/src/adapters/twilio.ts`,
`docs/decisions/ADR-007-multi-channel-relay.md`, `relay/README.md`.
**What changes with a paid SMS key or Twilio credentials:** either adapter switches on with an
environment variable on the Worker — no app release needed.

### "What if there's no internet?"
**Honest answer today:** The rule engine never needs the network. Weather/AQI use a last-known-good
cache with a "cached" badge, staleness bounded at 60 minutes, after which the heat rule reports
"stale" instead of judging. With no data connection, the relay call is skipped (not attempted and
failed) and the SOS flow falls back per-contact straight to the native SMS composer, which needs
only a cell signal, not data connectivity — this composer fallback is the one SOS path that has run
on a device.
**Evidence:** `src/environment/cache.ts`, `src/sos/deliver.ts`, `src/sos/config.ts` (`skipRelay`).
**What changes after the next EAS build:** an airplane-mode SOS test against the deployed relay will
be recorded on a device instead of only unit-tested.

### "Where is my history stored / can I delete it?"
**Honest answer today:** Up to seven days of heart rate, SpO₂, skin temperature, and per-minute
motion summaries are kept in a local SQLite database (`expo-sqlite`) inside the app's private
storage — never transmitted, never read by any network code path. It is currently **unencrypted**
(plaintext until M12, ADR-006); anything with access to the app's sandbox (root, an ADB backup)
could read it. Settings → Data sharing → "Erase my health data" clears every stored reading (and
nothing else — contacts and other settings are kept) behind a confirmation. Demo/simulated data is
never written to the store. This feature is merged but has not yet run against the real on-device
SQLite driver — a new EAS build is in progress to confirm it.
**Evidence:** `src/store/sqlite.ts`, `src/app/settings.tsx` (erase control),
`docs/features/reading-store.md`, `docs/decisions/ADR-006-local-reading-store.md`.
**What changes after device validation:** the "survives a force-stop, erase truly empties the file"
claims move from "proven against a fake database" to "proven on a phone."

### "Is Trends real data?"
**Honest answer today:** Yes, as of this merge — the Trends screen no longer renders a hardcoded
sample chart. It reads 24-hour/7-day history from the same local reading store described above and
computes real min/avg/max and a sparkline; a gap in the data renders as an honest empty slot, never
a misleading zero. On the simulated data source it still shows the "switch to a real source" banner
instead of a chart, even if real history happens to be sitting in the store from an earlier session.
This has not yet run on a device — the aggregation is unit-tested and the screen is integration
tested against a seeded in-memory store, not yet against the real SQLite driver.
**Evidence:** `src/trends/aggregate.ts`, `src/app/trends.tsx`, `docs/features/trends.md`.
**What changes after device validation:** numbers and the sparkline get confirmed against what the
Dashboard's own vitals row has actually been recording, on a real phone.

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
**Honest answer today:** Unit and integration tests (63 suites / 1457 tests for the app; 142 tests
for the relay, vitest). Device validation exists for the first Health Connect / SOS-composer run
(2026-09-20) and, separately, for the deployed relay's Telegram lane (2026-09-21, delivered by hand
with `curl`, not yet exercised from the app). No device validation yet for the reading store,
Trends, or the app's own relay dispatch/Telegram linking — all merged, all pending the next EAS
build. No real-world validation anywhere.
**Evidence:** `docs/testing/validation-levels.md`; `docs/PROJECT_STATUS.md` "Device Validated" section.
**What changes after the next EAS build:** the store, Trends, and app-side SOS relay dispatch move
to device validated the same way sensing and the relay's Telegram lane already have.

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
The only server that exists is a credential relay so the app never holds a provider's Telegram/SMS
credentials.
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

### "Does air quality affect the risk score?"
**Honest answer today:** On the reviewed, unmerged `feat/aqi-respiratory-advisory` branch, yes, in
two ways. Above EPA AQI 150 ("Unhealthy") the respiratory card raises an advisory — amber at
151–300, red at 301+ — with air-quality guidance, and the metric line shows the AQI and its EPA
band beside the SpO₂ reading. It is an advisory, not the PRD respiratory flag: only SpO₂ < 92%
flags, and only SpO₂ can trigger SOS — **the AQI advisory never triggers SOS**. Separately the
engine reports a respiratory weighting (up to +30% at AQI 300) that is deliberately not applied to
the score — it is there for a future fusion layer. On `master` today (before this PR merges) AQI is
fetched and displayed on the Environment screen only; the answer there is "not yet."
**Evidence:** `src/risk/rules/respiratory.ts`, `src/risk/__tests__/aqi-advisory.test.ts` (branch
`feat/aqi-respiratory-advisory`).
**What changes after personalisation:** users who opt in as sensitive get the advisory from AQI 101
(a later, human-reviewed milestone).

### "Does the app notify you if a risk goes critical while you're not looking at it?"
**Honest answer today:** On the reviewed, unmerged `feat/alert-notifications` branch, yes,
foreground-only for now. A rise into elevated/high risk, or a critical trigger such as a possible
fall, raises a local Android notification while the app is open in the background — never on the
demo/simulated data, only on live Health Connect readings, and only if the "Alert notifications"
toggle in Settings is on. It reuses the exact same rule engine that drives the Dashboard cards, so
the notification and the card can never disagree. **Notifications are foreground-only** until the
background foreground-service milestone (`docs/ROADMAP.md` M8) — nothing fires once the app is
fully closed. Not yet device-validated, and not yet on `master`.
**Evidence:** `src/alerts/`, `src/hooks/use-alerts.ts` (branch `feat/alert-notifications`).

### "Does the app know who I am, health-wise — age, conditions, whether I work outdoors?"
**Honest answer today:** On the reviewed, unmerged `feat/user-profile` branch, Settings has an
"About you" section for age band, a long-term condition flag, outdoor-worker status, and
pregnancy. It is stored only on the device and is never sent anywhere, including in an SOS alert.
It does not yet change any risk warning: that is a deliberate, documented decision (ADR-005)
requiring a methodology review before it ships, so this milestone only captures the profile as an
input for that future review. A regression test proves the risk engine's output is identical with
or without a filled-in profile today.
**Evidence:** `src/settings/profile.ts`, `src/__tests__/home-screen.test.tsx` (branch
`feat/user-profile`); `docs/decisions/ADR-005-personalisation-inputs-before-thresholds.md`.
