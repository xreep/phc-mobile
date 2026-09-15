/**
 * Tiered recommendations (PRD §7.2.4 extension).
 *
 * Every category used to carry one guidance string per *predicate*, and that is a different
 * thing from one string per *severity*. The two coincide often enough to look correct, and
 * they come apart in exactly the cases that matter:
 *
 * - **Respiratory.** `criticalConfirmed` needs two samples below 85 %. A single reading of
 *   82 % still scores 92/100, so the card said **Alert** — and the guidance under it was the
 *   flagged rung, "sit upright, rest, and breathe slowly". Advice for a mild desaturation,
 *   printed beneath a top-of-scale alert.
 * - **Dehydration.** The drift score already splits amber at 55, so that NOAA's Danger band
 *   reads worse than Extreme Caution at the same drift — and both halves emitted the same
 *   sentence, so a distinction the engine had computed never reached the user.
 * - **Cardiovascular.** One string covered HR 121 through 180, and another covered HR 39 down
 *   to 25. A resting heart rate of 26 got the same words as one of 39.
 *
 * So the selector is the score, through a ladder declared per category. That is the discipline
 * `levelForScore` already imposes — see the note on {@link SCORE_BANDS}, which argues that
 * presentation assigned independently of the score lets a rule "report `red` with a score of
 * 12 and the fusion layer would disagree with the card the user is looking at". A card reading
 * **Alert** beside mild-tier advice is that same failure wearing different clothes.
 *
 * ## Why the ladders are per category rather than three global cuts
 * Three global cuts cannot work here. Fatigue is capped at 69 — it may never be red — so a
 * global `severe` band at 90 leaves it one reachable tier, which is a "tiered" category with
 * no tiers. Dehydration's own ramps split amber at 55 and red at 70; heat's split red at 90,
 * because NOAA's Danger and Extreme Danger bands do. Each category subdivides whichever band
 * its physiology actually resolves, and no single pair of cuts subdivides both.
 *
 * What is enforced instead is the property that actually matters: **no rung may span a level
 * boundary.** The tier and the pill on the card therefore cannot disagree — `mild` only ever
 * appears on an amber card, `severe` only ever on a red one. {@link ladderProblems} checks
 * that structurally and `recommend.test.ts` runs all seven ladders through it — seven for six
 * categories, because cardiovascular declares one per direction — so a ceiling raised past 69
 * or a rung nudged to 65 fails there rather than shipping a card whose advice undersells its
 * own colour.
 *
 * ## Why a rule may override the rung
 * A score is one dimension, and a few distinctions do not lie on it. Suspected heat collapse
 * scores exactly what plain extreme heat scores, because both are driven by the heat index —
 * the difference is that one of them is an emergency already in progress. Those cases are
 * declared as standalone {@link Recommendation}s **at the tier their score would have selected
 * anyway**, so re-wording never moves the tier. `recommend.test.ts` pins that pairing for each
 * override rather than trusting this paragraph.
 */

import type { RiskLevel, RiskTier } from '../types';
import { levelForScore, SCORE_BANDS } from './shared';

/** Increasing severity. Index order is the comparison — `indexOf` is the only ranking. */
export const TIER_ORDER: readonly RiskTier[] = ['mild', 'moderate', 'severe'];

/**
 * Which level band each tier may appear in.
 *
 * `moderate` is the only tier allowed in either, and deliberately so: it is the middle rung,
 * and whether a category's middle rung lands in amber or red depends on which band that
 * category subdivides. Dehydration's moderate is amber; heat's is red. What the table forbids
 * is the pair that misleads — `mild` on a red card, `severe` on an amber one.
 */
const TIER_LEVELS: Readonly<Record<RiskTier, readonly RiskLevel[]>> = {
  mild: ['amber'],
  moderate: ['amber', 'red'],
  severe: ['red'],
};

/** How many concrete steps a rung may carry. More than three stops being read. */
const ACTIONS_PER_RUNG = { min: 2, max: 3 } as const;

/** How many rungs a ladder may declare (PRD §7.2.4 ext: "2–3 tiers"). */
const RUNGS_PER_LADDER = { min: 2, max: 3 } as const;

/** What to tell the user at one severity. */
export type Recommendation = {
  readonly tier: RiskTier;
  /** The one-liner that becomes `RuleOutcome.guidance`. */
  readonly headline: string;
  /** Imperative steps, most urgent first. */
  readonly actions: readonly string[];
};

/** A {@link Recommendation} plus the score at which it takes over. */
export type RecommendationRung = Recommendation & {
  /** Inclusive floor. Integer, so the band checks in {@link ladderProblems} are exact. */
  readonly minScore: number;
};

export type RecommendationLadder = {
  /**
   * Highest score the owning rule can produce. Bounds the top rung, which is the only way
   * to tell a fatigue ladder that stops at 69 from one that has quietly been allowed into red.
   */
  readonly ceiling: number;
  /** Ascending by `minScore` and by tier. */
  readonly rungs: readonly RecommendationRung[];
};

/**
 * The highest rung this score reaches, or `null` when it reaches none.
 *
 * `null` is the green case, and it is a real answer rather than a missing one: a category with
 * nothing elevated has no recommendation to make, and the rule supplies its own steady-state
 * line instead — see {@link tieredGuidance}.
 */
export function recommend(
  ladder: RecommendationLadder,
  score: number,
): Recommendation | null {
  // A non-finite score would fall through every `<` below — `NaN < 40` is false — and select
  // the *top* rung, putting "get medical help now" under a metric that reads `—`. Failing to
  // the highest severity looks like the safe direction and is not: an absent assessment is what
  // `unknownOutcome` is for, and it reaches this function as no recommendation at all.
  // `clampScore` means no shipped rule can produce one, so this is a guard on the export.
  if (!Number.isFinite(score)) return null;

  let reached: RecommendationRung | null = null;
  for (const rung of ladder.rungs) {
    if (score < rung.minScore) break;
    reached = rung;
  }
  return reached;
}

/** The three `RuleOutcome` fields a ladder decides, so no rule can source them separately. */
export type TieredGuidance = {
  readonly tier: RiskTier | null;
  readonly guidance: string;
  readonly actions: readonly string[];
};

/**
 * Fold a selected rung into the outcome fields.
 *
 * Spread into the returned `RuleOutcome` as one unit, which is the point: `tier`, `guidance`,
 * and `actions` cannot be set from three different branches of three different ternaries, so
 * a card can never show one tier's headline beside another's steps.
 */
export function tieredGuidance(
  advice: Recommendation | null,
  steady: string,
): TieredGuidance {
  if (advice === null) return { tier: null, guidance: steady, actions: [] };
  return { tier: advice.tier, guidance: advice.headline, actions: advice.actions };
}

/**
 * Everything structurally wrong with a ladder, in words. Empty means consistent.
 *
 * Returns a list rather than throwing so one test can report every problem in all six ladders
 * at once — a thrown error stops at the first, which turns a config sweep into six runs.
 */
export function ladderProblems(ladder: RecommendationLadder): readonly string[] {
  const problems: string[] = [];
  const { ceiling, rungs } = ladder;

  if (rungs.length < RUNGS_PER_LADDER.min || rungs.length > RUNGS_PER_LADDER.max) {
    problems.push(
      `expected ${RUNGS_PER_LADDER.min}–${RUNGS_PER_LADDER.max} tiers, found ${rungs.length}`,
    );
  }
  if (rungs.length === 0) return problems;

  const top = rungs[rungs.length - 1];
  if (!Number.isInteger(ceiling) || ceiling < top.minScore || ceiling > SCORE_BANDS.red.max) {
    problems.push(
      `ceiling ${ceiling} must be a whole number between ${top.minScore} (the top tier) and ${SCORE_BANDS.red.max}`,
    );
  }

  const headlines = new Set<string>();

  rungs.forEach((rung, index) => {
    const previous = index === 0 ? null : rungs[index - 1];

    if (!Number.isInteger(rung.minScore)) {
      // A fractional floor would make the `minScore - 1` span arithmetic below inexact, and
      // with it the guarantee that a rung sits inside one band.
      problems.push(`${rung.tier} starts at ${rung.minScore}, which is not a whole number`);
    }

    if (previous === null) {
      if (rung.minScore < SCORE_BANDS.amber.min) {
        problems.push(
          `${rung.tier} starts at ${rung.minScore}, below the amber floor ${SCORE_BANDS.amber.min} — a green card would carry a recommendation`,
        );
      }
    } else {
      if (rung.minScore <= previous.minScore) {
        problems.push(
          `${rung.tier} starts at ${rung.minScore}, not above ${previous.tier}'s ${previous.minScore}`,
        );
      }
      if (TIER_ORDER.indexOf(rung.tier) <= TIER_ORDER.indexOf(previous.tier)) {
        problems.push(`${rung.tier} does not outrank ${previous.tier}`);
      }
    }

    // The rung owns `[minScore, spanTop]`. Both endpoints are integers and `levelForScore` is
    // monotone with integer boundaries, so agreement at the ends proves it for the interior —
    // including the fractional scores the interpolations actually emit.
    const spanTop = index === rungs.length - 1 ? ceiling : rungs[index + 1].minScore - 1;
    const bottomLevel = levelForScore(rung.minScore);
    const topLevel = levelForScore(spanTop);

    if (spanTop < rung.minScore) {
      problems.push(`${rung.tier} owns no scores at all (${rung.minScore}–${spanTop})`);
    } else if (bottomLevel !== topLevel) {
      problems.push(
        `${rung.tier} spans ${rung.minScore}–${spanTop}, crossing the ${bottomLevel}/${topLevel} boundary`,
      );
    } else if (!TIER_LEVELS[rung.tier].includes(bottomLevel)) {
      problems.push(`${rung.tier} sits in the ${bottomLevel} band, where it may not appear`);
    }

    if (rung.headline.trim().length === 0) {
      problems.push(`${rung.tier} has no headline`);
    } else if (headlines.has(rung.headline)) {
      // The whole point of the feature. Two rungs with one sentence is the static string
      // this replaced, wearing a tier label.
      problems.push(`${rung.tier} repeats an earlier tier's headline`);
    } else {
      headlines.add(rung.headline);
    }

    if (
      rung.actions.length < ACTIONS_PER_RUNG.min ||
      rung.actions.length > ACTIONS_PER_RUNG.max
    ) {
      problems.push(
        `${rung.tier} has ${rung.actions.length} steps, outside ${ACTIONS_PER_RUNG.min}–${ACTIONS_PER_RUNG.max}`,
      );
    }
    if (rung.actions.some((action) => action.trim().length === 0)) {
      problems.push(`${rung.tier} has an empty step`);
    }
    // Distinct within the rung, because the card keys its bullet list on the step text — and
    // because a repeated step is a copy-paste that quietly costs the rung one of its two or
    // three chances to say something useful.
    if (new Set(rung.actions).size !== rung.actions.length) {
      problems.push(`${rung.tier} repeats a step`);
    }
  });

  return problems;
}
