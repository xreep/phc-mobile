/**
 * Community View (PRD §4, ASHA persona) — the shapes an anonymized area summary would have.
 *
 * This module and the screen above it are a **concept demonstration**. There is no backend, no
 * peer-to-peer link, and no upload path anywhere in the app; the figures come from a fixed
 * local cohort in `./demo-cohort.ts`. That is stated in the types because the types are what a
 * later real implementation would keep, and the thing most likely to be lost in that
 * transition is the honesty about which parts were ever real.
 *
 * ## Why the report shape is this narrow
 * An ASHA worker's actual question is "who in my ward needs a visit today", and the smallest
 * answer to it is a count per risk category. So a report carries a coarse area, one category,
 * one level, and a timestamp — and nothing else. No identifier, no coordinate, no vitals, no
 * age, no device id.
 *
 * That is not merely minimal, it is the design constraint: every field added here is a
 * quasi-identifier, and quasi-identifiers compose. Area plus age band plus category is enough
 * to name a person in a village of two hundred even though no single field identifies anyone.
 * The narrow shape is what makes the suppression in `./aggregate.ts` sufficient rather than
 * decorative.
 *
 * ## One report per participant, not one per category
 * A participant contributes a single report carrying their **worst** category. The alternative
 * — one report per elevated category — reads the same on screen and means something different:
 * one person having a hard day would appear in the heat count, the dehydration count, and the
 * cardiovascular count at once, so an ASHA reading "3 heat, 2 dehydration" would plan five
 * visits for three people. Counts that can be added up are worth more than counts that are
 * merely larger.
 */

import type { RiskCategoryKey, RiskLevel } from '@/risk';

/**
 * One participant's contribution for one interval.
 *
 * `area` is a named bucket — a ward, a village — never a coordinate. Coarsening a latitude to
 * two decimal places still describes a 1 km square, which in a rural ward is a household, so
 * the aggregate is keyed on an administrative name that the device never has to derive from a
 * fix at all.
 */
export type AnonymizedReport = {
  readonly area: string;
  /** The participant's highest-severity category at report time. */
  readonly category: RiskCategoryKey;
  /** Their level in that category. `green` participants are counted in the cohort but are
   *  not "elevated" — see {@link CommunitySummary.participants}. */
  readonly level: RiskLevel;
  readonly reportedAt: number;
};

/**
 * How many participants are elevated in one category, or the fact that this is being withheld.
 *
 * `count` and `level` are `null` together, and that pairing is a privacy property rather than a
 * convenience: publishing `level: 'red'` beside a withheld count would disclose that at least
 * one person is at red, which is most of what the suppression exists to prevent. Whoever reads
 * a withheld row learns only that the number is below the threshold — not whether it is 0, 1,
 * or 2, and not how bad it is.
 */
export type CategoryTally = {
  readonly category: RiskCategoryKey;
  /** Taken from the engine's own `CATEGORY_LABELS`, so a row here and a card on the Dashboard
   *  cannot end up calling the same category two different things. */
  readonly label: string;
  /** Worst level among the elevated participants, or `null` when the count is withheld. */
  readonly level: RiskLevel | null;
  /** Elevated participants, or `null` when fewer than the suppression threshold. */
  readonly count: number | null;
};

/** An area summary as it would be published to a community health worker. */
export type CommunitySummary = {
  readonly area: string;
  /** The instant the summary was computed for — supplied, never read from a clock, so the
   *  screen and its tests see the same window. */
  readonly generatedAt: number;
  /** Lookback the counts describe. Rendered, because "4 people" means nothing without it. */
  readonly windowMs: number;
  /** The `k` every published count had to reach. Shown on screen: a reader who does not know
   *  the threshold cannot tell a withheld row from a zero. */
  readonly suppressionThreshold: number;
  /**
   * Participants in this area and window, or `null` when the cohort itself is below the
   * threshold.
   *
   * Suppressed for its own sake, not just for tidiness. A published cohort of 2 combined with
   * a withheld heat row narrows that row to {0, 1, 2} out of 2, which is close to an
   * individual disclosure by arithmetic alone.
   */
  readonly participants: number | null;
  /** Every engine category, in the Dashboard's order, so a category with nothing to report is
   *  visibly quiet rather than absent. */
  readonly tallies: readonly CategoryTally[];
  /** One-line summary, or `null` when no category reached the threshold and there is
   *  therefore nothing that may be said. */
  readonly headline: string | null;
};
