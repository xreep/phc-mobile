/**
 * Plain-language environmental context for a category (PRD §7.2.2 / §7.2.3).
 *
 * ## What this is for
 * `CategoryAssessment.envMultiplier` is the one number the engine computes and deliberately
 * does **not** apply. `rules/respiratory.ts` derives it from AQI, `rules/cardiovascular.ts`
 * from the heat flag, and both hand it back untouched so the future fusion layer can weight it
 * once rather than twice — see the field's doc on `CategoryAssessment` and `index.ts` on what
 * Tier 1 is not.
 *
 * That design is right, and it had a side effect: the value was invisible. It was computed,
 * carried through the whole pipeline into `CategoryAssessment`, and then rendered by nothing,
 * which is its own kind of dishonesty — a factor the engine tracks and the reader is never told
 * about. This module is the honest surface for it.
 *
 * ## Why the disclaimer is part of the return value rather than the card's business
 * A multiplier shown on its own, beside a score, reads as though the score had already
 * absorbed it. That is the single thing which is not true here, so the sentence that says so
 * travels with the number instead of being left to each caller to remember. The copy lives in
 * this layer for the same reason `guidance` and `actions` do: the engine owns which
 * environmental input drives which category, and a second copy of that mapping in the UI is a
 * second thing to keep in sync.
 *
 * Pure and framework-free like the rest of `src/risk` — no React, no clock, no I/O.
 */

import type { RiskCategoryKey } from './types';

/** The heading the context block renders under, shared so tests and UI cannot drift. */
export const ENV_CONTEXT_LABEL = 'Environmental context';

/**
 * The half of the message that keeps the other half honest.
 *
 * Names both `score` and `level`, because the card shows the level as a word ("Caution") and
 * the score only indirectly — a disclaimer that mentioned just the score would leave the
 * colored pill looking like the thing the multiplier had moved.
 *
 * It disclaims *this weighting*, not air quality as a whole. The sentence used to end "which
 * come from your body readings alone", and that stopped being true when the respiratory rule
 * grew its air-quality advisory (`respiratory.aqi.*`): above `env.aqiAdvisoryAbove` the card's
 * level does follow the air — through a configured advisory score named on the metric line,
 * never through this percentage. The percentage is still reported and still not applied, and
 * that is the only claim the sentence makes now.
 */
export const ENV_CONTEXT_DISCLAIMER =
  'Environmental context only — this weighting is not included in the score or status above.';

export type EnvironmentalContext = {
  /** Which environmental input this came from, in the reader's words. */
  readonly factor: string;
  /** One sentence naming the factor and how much the engine weights it. */
  readonly detail: string;
  /** Always `ENV_CONTEXT_DISCLAIMER`. Carried along so it cannot be rendered without. */
  readonly disclaimer: string;
  /** The engine's raw multiplier, unrounded, for callers that want the exact figure. */
  readonly multiplier: number;
  /** `multiplier` as a whole-number percentage uplift: `1.3` → `30`. Always >= 1. */
  readonly percent: number;
};

/**
 * Per-category copy, keyed by the closed `RiskCategoryKey` union so the compiler names every
 * category if one is added.
 *
 * `null` means "this category has no environmental amplification by design", and each of the
 * four has a different reason, recorded where the rule makes the decision: heat is the *source*
 * of amplification rather than a recipient (`rules/heat.ts`), dehydration already has the heat
 * load as one half of its conjunction so multiplying by it again would count the same evidence
 * twice (`rules/dehydration.ts`), and fall and fatigue read no weather at all.
 */
const DETAIL_BY_CATEGORY: Readonly<
  Record<RiskCategoryKey, ((percent: number) => string) | null>
> = {
  heat: null,
  respiratory: (percent) =>
    `Air quality is poor right now. The engine weights that as adding about ${percent}% to breathing risk, on top of what your blood-oxygen reading shows.`,
  cardiovascular: (percent) =>
    `Heat is high right now. The engine weights that as adding about ${percent}% to cardiac strain, on top of what your heart rate shows.`,
  fall: null,
  dehydration: null,
  fatigue: null,
};

/** Reader-facing name of the environmental input behind each multiplier. */
const FACTOR_BY_CATEGORY: Readonly<Record<RiskCategoryKey, string | null>> = {
  heat: null,
  respiratory: 'Air quality',
  cardiovascular: 'Heat',
  fall: null,
  dehydration: null,
  fatigue: null,
};

/**
 * The context to show for a category, or `null` when there is nothing honest to say.
 *
 * Takes a structural subset rather than a whole `CategoryAssessment` so it can be unit-tested
 * against literals, while still accepting a real assessment unchanged.
 *
 * Returns `null` in three cases, and the third is the interesting one:
 *
 * - the category has no environmental input (see `DETAIL_BY_CATEGORY`);
 * - there is no multiplier, or it is not a finite number;
 * - **the uplift rounds to nothing.** `airQualityMultiplier` ramps *continuously* from AQI 100,
 *   so at AQI 101 it is 1.0015. Rendering a paragraph about poor air quality for a 0.15%
 *   weighting would be noise, and rendering the figure itself would read "about 0%". One
 *   percent is the floor at which the sentence is worth the reader's attention.
 */
export function environmentalContextFor(category: {
  readonly key: RiskCategoryKey;
  readonly envMultiplier?: number;
}): EnvironmentalContext | null {
  const multiplier = category.envMultiplier;
  if (multiplier === undefined || !Number.isFinite(multiplier)) return null;

  const detail = DETAIL_BY_CATEGORY[category.key];
  const factor = FACTOR_BY_CATEGORY[category.key];
  if (detail === null || factor === null) return null;

  const percent = Math.round((multiplier - 1) * 100);
  if (percent < 1) return null;

  return {
    factor,
    detail: detail(percent),
    disclaimer: ENV_CONTEXT_DISCLAIMER,
    multiplier,
    percent,
  };
}
