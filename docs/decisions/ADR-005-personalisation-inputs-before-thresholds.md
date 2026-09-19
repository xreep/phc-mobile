# ADR-005: Capture personalisation inputs before touching risk thresholds

## Status

Proposed — capture-only implementation shipped (workstream D1); no threshold change has been
made or reviewed.

## Context

PS §3d asks for high-risk notifications for vulnerable individuals, and the PRD's personas
include elderly users, people with a chronic condition, and outdoor workers. Until this
workstream, the app had no representation of who the user is at all — the rule-based risk
engine (`src/risk/`) scores every user identically regardless of age, health history, or
occupation.

The obvious next step is to let a vulnerable user's profile lower a threshold or bring a
warning forward — e.g. an earlier heat advisory for someone 60+ or working outdoors, an
earlier notification for someone with a chronic cardiovascular or respiratory condition. That
is a **health-methodology decision**: it changes what the app tells a user is or is not
dangerous, for a class of users chosen specifically because they are more vulnerable to being
wrong. It is not a decision this workstream is positioned to make unilaterally — it needs a
documented rationale, ideally with clinical or public-health input, before it ships.

## Decision

Split the work into two milestones:

1. **This workstream (D1):** add the profile schema, validated persistence, and Settings UI so
   the app can capture age band, chronic condition, outdoor-worker, and pregnancy status. Add a
   pure `vulnerabilityFactors` / `isVulnerable` classification over that profile. **Do not**
   change any rule, threshold, or engine output based on it.
2. **A future milestone (not started):** with a documented methodology review, decide which of
   the candidate threshold adjustments below (if any) are applied, and how, then wire the
   profile into `src/risk/` deliberately, with its own tests and its own sign-off.

A regression test (`src/__tests__/home-screen.test.tsx`, describe block "profile is a no-op for
the risk engine") pins the current behaviour: rendering the Dashboard with every vulnerability
factor turned on must produce byte-identical risk output to the default profile. That test is
the guard against this decision being silently reversed by an unrelated change.

### Candidate threshold adjustments for the next milestone (NOT implemented — questions for the human reviewer)

- Should the heat-advisory band (`src/risk/rules/heat.ts`) step down one level earlier for
  `age60plus` or `outdoorWorker` profiles, and by how much?
- Should a chronic cardiovascular or respiratory condition bring the Cardiovascular/Respiratory
  category's amber threshold forward, and does that require knowing *which* condition (the
  current schema only captures a single boolean, not a condition type)?
- Should `pregnant` affect the heat or cardiovascular categories, and if so is that a
  well-established enough relationship to encode as a fixed offset, or does it need a
  different presentation (e.g. a caution banner) rather than a score change?
- Should `under18` change anything at all, given the PRD's personas are adult (elderly,
  outdoor workers) and no methodology source for a minor-specific adjustment has been
  identified?
- If any adjustment ships, does it change `RiskAssessment.score` (and therefore
  `envMultiplier`/Tier-2 fusion math), or only `level`/guidance text? These have different
  blast radii and the ADR that authorises the change should say which.

## Options considered

- **Bake adjustments in now, alongside the schema.** Rejected: it would ship an unreviewed
  health-methodology change under the description "add a settings field," which is the kind of
  change that should be traceable to its own decision record and its own sign-off, not folded
  into a UI/persistence workstream.
- **Capture-first, apply later (chosen).** The schema and UI are useful on their own — they are
  the input a future review needs — and shipping them as a proven no-op means the risk engine's
  existing, already-tested behaviour is provably unchanged. The regression test makes "provably"
  more than an assertion.
- **Do nothing until the methodology review happens.** Rejected: it blocks Settings UI work and
  the profile capture itself on a decision that does not need to be made first — a user can
  usefully tell the app their age band today even if it does not act on it yet.

## Consequences

- Positive: the Settings screen now has a real "About you" section, and the data it captures is
  validated on read exactly like the rest of the settings store (`src/settings/store.ts`), so a
  future milestone can trust it.
- Positive: the regression test in `home-screen.test.tsx` makes "this is currently a no-op" a
  CI-enforced fact rather than a comment someone can forget to update.
- Negative: a user who fills in "About you" today gets no different risk output than one who
  does not, which the Settings copy states plainly ("Used to tailor risk warnings on this
  phone") but which is not yet true. The copy should be revisited if the next milestone stalls.
- Follow-up: the next milestone must review the candidate adjustments above with someone who
  can speak to the clinical/public-health rationale, decide which apply, and land them as
  deliberate, tested changes to `src/risk/`, not as an extension of this ADR.

## Validation

Device validated: NO. Unit tested / Integration tested (Jest) only — see the report for this
workstream for the exact test files and run output.
