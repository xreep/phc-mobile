# ADR-002: Deterministic rules before machine learning

## Status
Accepted — reflected in the shipped architecture. `src/risk/` is a deterministic rule engine; no ML
model exists anywhere in this build.

## Context
PRD Goal G2 calls for "on-device AI inference" and the original PRD lists a TFLite model as part of
the vision (§7.2.2, "Tier-2"). PS 26181's expected-solution area 2d asks for "risk assessment via
on-device AI inference." A judge will ask "where is your AI?"

## Problem
Should the first-shipped risk assessment be a trained model or a deterministic engine, given limited
time, no representative on-device sensor dataset, and a safety-critical output (a wrong alert during
a disaster is worse than none)?

## Options
1. **Train a deep-learning model first** (e.g. on WESAD or PPG-DaLiA, as the PRD originally
   suggested) and ship it as the primary risk assessment.
2. **Deterministic rule engine first**, with score/`envMultiplier` outputs shaped so a learned tier
   can fuse in later, once it can be validated.
3. **Skip a model entirely** and never build a learned component.

## Decision
Option 2. `src/risk/assess.ts` fuses six physiological rules (heat, respiratory, cardiovascular,
fall, dehydration, fatigue) with environmental context into a 0–100 score and tiered guidance. Every
threshold is sourced (NOAA heat index; WHO/AHA SpO₂ and HR guidance, cited in `risk/config.ts`
comments) and requires sustained evidence before escalating, to control false alarms. The rule
engine's outputs are deliberately shaped to fuse with a future learned tier (a personal-baseline
anomaly score, per `docs/ROADMAP.md` M10), but no such model has been built or shipped.

## Reason
- **Dataset mismatch.** WESAD and PPG-DaLiA are 700 Hz lab PPG/EDA datasets; this app's real input is
  once-a-minute Health Connect samples. A model trained on the former would be trained on data shaped
  nothing like the app's actual input (audit §F).
- **Validation honesty.** A rule engine's thresholds can be cited to public guidance and tested
  exhaustively (~600 tests, including "unsatisfiable threshold" regressions); a trained model's
  accuracy cannot be honestly claimed without a real dataset and a measured false-positive rate,
  which this team does not have.
- **Safety asymmetry.** In a disaster-response tool, a wrong alert is costly (alert fatigue, a family
  member scared for no reason) and a missed one is worse. Rules that require sustained, multi-sample
  evidence before escalating are easier to reason about and defend on stage than a black-box score.

## Consequences
- Today's honest answer to "where is your AI?" is "a deterministic rule engine, not yet a learned
  model" — this is defensible but not what the original PRD's language implied, and the documentation
  (`docs/JUDGE_QA.md`) says so directly rather than overselling the rule engine as "AI."
- The `score`/`envMultiplier` fusion hooks have had no consumer for weeks (audit §C), which is a
  visible gap a judge may notice reading `PRD.md` next to the code.
- The planned Tier-2 (M10 in `docs/ROADMAP.md`) is a statistical, explainable anomaly score (EWMA/
  z-score against the user's own baseline) evaluated *first*, with TFLite only adopted if it
  demonstrably beats the statistical baseline — not defaulted to because the PRD names it.

## Alternatives rejected
- **Train a deep-learning model first** — rejected: no dataset shaped like the real input exists, and
  shipping an unvalidated model as the primary safety mechanism contradicts the disaster-resilience
  use case.
- **Skip a learned component entirely** — not rejected in principle for the MVP (it is what shipped),
  but rejected as a long-term position: PS 26181 area 2d explicitly asks for on-device AI inference,
  and an explainable personal-baseline tier is a defensible way to deliver it without the dataset
  problem above.
