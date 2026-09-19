# AQI advisory in the respiratory rule

## Feature
The respiratory risk card now reacts to bad air: above an EPA AQI of 150 the deterministic rule
engine raises an **advisory precursor** (`respiratory.aqi.unhealthy` / `.veryUnhealthy` /
`.hazardous`) that moves the card's level, score, and guidance — without ever setting the PRD
§7.2.2 respiratory *flag*, which remains SpO₂ < 92 % and nothing else.

## Objective
PS 26181 §3b asks for "air-quality and respiratory-risk alerts". Before this change the engine
computed a respiratory `envMultiplier` from AQI but — by design — only *reported* it, so the card
stayed green in hazardous air and a judge in Delhi would have watched the Environment screen say
"Unhealthy" while the Dashboard said "Normal". This brings ROADMAP milestone M3 forward (P0 in the
prototype audit, §B row 2b/3b).

## Problem
`EnvironmentSnapshot.aqi` was documented as "Unused by Tier 1". The multiplier is deliberately
not folded into `score` (the fusion layer applies it once, later), which was correct but left the
number invisible to the level. The gap: no mechanism by which air quality alone could change what
the user sees, and no guidance about what to do in bad air.

## Architecture
Pure engine change inside `src/risk/`; no UI code changed. The advisory follows the pattern
`heat.index.extremeCaution` established (`src/risk/rules/heat.ts`): a rule that sets level/score/
guidance and appears in `firedRules`, but is in neither `SPEC_FLAG_RULES` nor `CRITICAL_RULES`.
Two independent mechanisms now read AQI in `rules/respiratory.ts`:

| Mechanism | Input | Output | Applied to the level? |
| --- | --- | --- | --- |
| `envMultiplier` (PRD §7.2.3) | AQI ramp 100 → 300 | `1.0 … 1.3`, reported | **No** — unchanged, for the fusion layer |
| `respiratory.aqi.*` advisory (this feature) | EPA band above `env.aqiAdvisoryAbove` | configured score 40 / 55 / 70 | **Yes** — via `levelForScore`, like every rule |

The engine keeps its "imports only four *types* from the app" guarantee (`src/risk/index.ts`
header): the two EPA band edges it needs are restated in `src/risk/aqi-bands.ts` rather than
imported from `src/environment/aqi.ts`, and a test cross-checks the labels against
`aqiCategoryFor` at every boundary so the copy cannot drift. See `docs/architecture/overview.md`
for where the engine sits.

## Implementation
**EPA band table** (airnow.gov; the engine reacts only to the last three):

| AQI | EPA label | Rule | Score (default) | Card |
| --- | --- | --- | --- | --- |
| 0–50 | Good | — | SpO₂ score only | unchanged |
| 51–100 | Moderate | — | SpO₂ score only | unchanged |
| 101–150 | Unhealthy for Sensitive Groups | — (below `aqiAdvisoryAbove`) | SpO₂ score only | unchanged; multiplier reported |
| 151–200 | Unhealthy | `respiratory.aqi.unhealthy` | 40 | amber, `mild` rung |
| 201–300 | Very Unhealthy | `respiratory.aqi.veryUnhealthy` | 55 | amber, `moderate` rung |
| 301+ | Hazardous | `respiratory.aqi.hazardous` | 70 | red, `severe` rung — **still not a flag** |

**Why 150 is the general-population line.** EPA's cautionary statement for 101–150 is addressed
to sensitive groups only; from 151 ("Unhealthy") it is addressed to everyone. The engine knows
nothing about the user's conditions yet, so 151 is the first point at which raising the card is
defensible for an arbitrary person. Below it, the general population gets no level change.
Vulnerable-group personalisation (asthma, heart disease, children, elderly) is a later milestone:
it will *lower* `env.aqiAdvisoryAbove` for those users, and the code is written so that lowering
the line extends the lowest rung downward rather than inventing a band.

**Why the multiplier stays reported-only.** `RiskThresholds.env` documents that the fusion layer
applies `envMultiplier`; applying it in the engine as well would square the effect. The advisory is
a *separate* mechanism with a configured score, never a multiplied one — `assess.test.ts` asserts
the score above the line is the advisory number and not `spo2Score × multiplier`.

**Combination with SpO₂.** `score = max(spo2Score, advisoryScore)`; `level = levelForScore(score)`;
`firedRules` is severity-descending with SpO₂ rules first (`respiratory.spo2.critical`,
`respiratory.spo2.low`, then the advisory); `rule = firedRules[0]`. `flagged` and `criticalRules`
come from SpO₂ only. Guidance follows the driving rule: a second respiratory ladder
(`RESPIRATORY_AQI_RECOMMENDATIONS`, three rungs at 40/55/70) is read when an advisory drives the
card, the existing SpO₂ ladder otherwise — the same "two ladders, predicate picks the ladder,
score picks the rung" pattern cardiovascular uses. `resolveRiskThresholds` keeps the three scores
monotone and caps them at the floor of red (70), so an SpO₂ flag (score ≥ 70) always outscores an
advisory and its wording is never replaced by air-quality text.

**No usable SpO₂.** If the band is off but an advisory fires, the card shows the advisory with
`dataQuality: 'partial'` and metric `SpO₂ — · AQI 250 (Very Unhealthy)` — it does not stay silent
green about hazardous air for want of a reading.

**Staleness.** The advisory applies only when `environment.observedAt` is within
`env.maxStaleMs` (60 min) of `now`, via a new shared `isEnvironmentStale` helper that the heat rule
now also uses. A stale observation produces no advisory (not a stale-flagged one). Note the
deliberate asymmetry: heat keeps firing on stale data and marks the outcome `stale`, because a heat
flag is a PRD §7.2.2 rule the engine may not suppress; an advisory is not.

**Metric line.** ` · AQI <n> (<EPA label>)` is appended only when an advisory fired, so cards in
clean air are visually unchanged. The number is *not* repeated in the guidance headline (the
ladders are static so `ladderProblems` can validate them; the metric line directly above carries
it).

**Environmental-context disclaimer.** `ENV_CONTEXT_DISCLAIMER` used to end "which come from your
body readings alone". That is no longer true above the line, so it now reads "Environmental
context only — this weighting is not included in the score or status above." — the only claim
that remains true.

## Files
- `src/risk/rules/respiratory.ts` — the advisory, the second ladder, metric composition.
- `src/risk/aqi-bands.ts` — engine-local EPA band edges and labels (new).
- `src/risk/rules/shared.ts` — `isEnvironmentStale` (new helper).
- `src/risk/rules/heat.ts` — uses the shared helper (behaviour unchanged).
- `src/risk/types.ts` — three `RuleId`s, four `env` thresholds, `EnvironmentSnapshot.aqi` doc.
- `src/risk/config.ts` — defaults (150; 40/55/70) and `repairEnv` (monotone + cap).
- `src/risk/env-context.ts` — disclaimer wording.
- Tests: `src/risk/__tests__/aqi-advisory.test.ts` (new), `assess.test.ts`, `recommend.test.ts`,
  `env-context.test.ts`, `src/__tests__/risk-card.test.tsx`, `src/__tests__/home-screen.test.tsx`,
  `src/constants/__tests__/mock-sensor-window.test.ts`.

## Data Flow
OpenWeatherMap air-pollution components → `src/environment/aqi.ts` (`estimateAqi`, EPA 0–500) →
`LiveEnvironment.aqi` → `toEnvironmentSnapshot` → `EnvironmentSnapshot.aqi` + `observedAt` →
`assessRisk` → `assessRespiratory` → `CategoryAssessment` (level/score/rule/metric/guidance) →
`RiskCard`. Nothing leaves the device; the advisory is never part of an SOS payload because it is
never critical.

## Tests
Unit (Jest), `src/risk/__tests__/aqi-advisory.test.ts` — 69 cases:
- band boundaries 150/151, 200/201, 300/301; the 150 line, band edges, and default scores pinned;
- AQI 168 + normal SpO₂ → amber, `rule === 'respiratory.aqi.unhealthy'`, `flagged/critical/
  sosCandidate === false`, mild rung, metric `SpO₂ 98% · AQI 168 (Unhealthy)`, multiplier unchanged;
- AQI 168 + SpO₂ 84×2 → critical wins; `firedRules === [critical, low, aqi.unhealthy]`; SpO₂ ladder;
- AQI 350 → red at 70, not flagged, not in `flaggedRules`, rolls the top-level level to red;
- no SpO₂ + AQI 250 → advisory with `dataQuality: 'partial'`;
- stale observation (60 min + 1 ms) → no advisory; exactly 60 min → advisory; no `observedAt` →
  treated as current (as heat does);
- `aqi` undefined / on the line / stale / no environment → **byte-identical** to outputs captured
  from the engine before the change (`toStrictEqual` against literals);
- never a flag across AQI 0–500; not in `SPEC_FLAG_RULES` / `CRITICAL_RULES`;
- thresholds: lowering the line, raising it past a band, monotone repair, cap at red floor;
- engine-local labels agree with `aqiCategoryFor` at 16 probe values.
Also extended: `recommend.test.ts` (eighth ladder through `ladderProblems`), `assess.test.ts`
(multiplier-vs-advisory test; hazardous-air environment added to the flag/level invariant sweep,
now 1232 scenarios). Screen tests updated for the shared fixture (AQI 168) rendering the
respiratory card amber. Full suite: 49 suites / 1159 tests.

## Device Validation
**Device validated: NO.** Unit tested / Integration tested (Jest) only. Live AQI has been seen on
the Environment screen on the August APK; the respiratory card reacting to it has not been observed
on a device.

## Known Limitations
- **Colour disagreement with the Environment screen.** `src/environment/aqi.ts` colours EPA
  "Unhealthy" red (EPA's own colour), while the respiratory card goes amber at the same AQI; they
  agree on the label ("Unhealthy") but not the colour. The card colours the *person's risk* (an
  advisory, not a flag), the screen colours the *air*. See "decisions to veto" in the report.
- General population only; no per-user sensitivity (asthma, heart disease) yet.
- The AQI is an estimate from instantaneous PM concentrations against 24-hour breakpoints (see
  `src/environment/aqi.ts`); the advisory inherits that approximation.
- When SpO₂ is stale and the advisory drives the card, `dataQuality` stays `'stale'` (it describes
  the SpO₂ behind the metric), which the card may render as a staleness note beside an air-driven
  level.
- No notification is raised; the advisory is visible only when the Dashboard is open (notifications
  are a separate milestone).

## Security
No new permissions. Reads the environment snapshot the app already holds.

## Privacy
Touches AQI (public data for a coarse location) and the SpO₂ reading already in the buffer. Nothing
is transmitted or stored by this feature. See `docs/security/privacy-architecture.md`.

## Future Improvements
- Vulnerable-group personalisation: a settings toggle that lowers `env.aqiAdvisoryAbove` to 100
  for users who opt in (ROADMAP personalisation milestone).
- Local notification on the first transition into an advisory band.
- Align the Environment screen's AQI pill colours with the engine, or document the difference on
  the screen, once a human has chosen which of the two mappings is the product's.

## Status
Built · Unit tested · Integration tested (Jest) — **not device validated**.

## Proposed status-doc updates

### `docs/PROJECT_STATUS.md`
- Line 28 (gaps): replace "**AQI** — fetched and displayed on the Environment screen, but not wired
  into the respiratory rule's `envMultiplier`…" with: "**AQI** — wired into the respiratory rule:
  `envMultiplier` (reported, not applied) plus an advisory precursor at EPA Unhealthy+ that turns
  the card amber/red without setting the SpO₂ flag (`docs/features/aqi-respiratory-advisory.md`).
  General population only; no per-user sensitivity yet."
- Line 53 (next steps): remove "Wire AQI into the respiratory rule…" or mark done.

### `docs/BUILD_MATRIX.md`
| Feature | Implemented | Tested | Device Validated | Real-World Validated | Status |
| --- | --- | --- | --- | --- | --- |
| Rule engine — respiratory | ✅ | ✅ | ❌ | ❌ | Unit tested (SpO₂ flag + AQI advisory) |
| AQI → risk (respiratory advisory at EPA Unhealthy+; `envMultiplier` reported) | ✅ | ✅ | ❌ | ❌ | Unit tested; not device validated |

### `docs/ROADMAP.md`
- M3 "AQI wired into risk": mark the advisory and band tests done; note the remaining gate item
  "Environment and Dashboard agree" is met for the *label* and not for the *colour* (see Known
  Limitations) pending a product decision.

### `CHANGELOG.md` (Unreleased → Added)
- Respiratory rule: air-quality advisory precursor (`respiratory.aqi.unhealthy` / `.veryUnhealthy`
  / `.hazardous`) at EPA AQI 151+ / 201+ / 301+, scoring 40 / 55 / 70 — moves the card's level and
  guidance, never the SpO₂ flag or SOS. Applies only to a weather observation within 60 minutes.
  New thresholds `env.aqiAdvisoryAbove`, `env.aqiUnhealthyScore`, `env.aqiVeryUnhealthyScore`,
  `env.aqiHazardousScore`. `envMultiplier` unchanged. Environmental-context disclaimer reworded to
  disclaim the weighting only. **Validation:** unit/integration tested; not device validated.

### `docs/JUDGE_QA.md`
#### "Does air quality affect the risk score?"
**Honest answer today:** Yes, in two ways. Above EPA AQI 150 ("Unhealthy") the respiratory card
raises an advisory — amber at 151–300, red at 301+ — with air-quality guidance, and the metric line
shows the AQI and its EPA band beside the SpO₂ reading. It is an advisory, not the PRD respiratory
flag: only SpO₂ < 92 % flags, and only SpO₂ can trigger SOS. Separately the engine reports a
respiratory weighting (up to +30 % at AQI 300) that is deliberately *not* applied to the score —
it is there for a future fusion layer. Below AQI 150 the general population sees no level change;
per-user sensitivity (asthma, heart disease) is not implemented yet.
**Evidence:** `src/risk/rules/respiratory.ts`, `src/risk/__tests__/aqi-advisory.test.ts`.
**What changes after personalisation:** users who opt in as sensitive get the advisory from AQI 101.
