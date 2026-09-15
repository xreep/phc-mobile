/**
 * Heat-stress rule (PRD §7.2.2): **heat index crossing "Danger" or "Extreme Danger"
 * → heat stress flag.**
 *
 * The index itself lives in `../heat-index.ts`, which owns the NOAA/NWS provenance and
 * the reason every comparison happens in Fahrenheit. This file is only the rule: which
 * bands flag, and what to tell the user.
 *
 * It also carries PRD §7.2.5's critical escalation — extreme heat combined with no
 * movement for over ten minutes, i.e. suspected heat collapse. That is the one rule
 * here that reaches past the short vitals window, via `extendedReadings`.
 *
 * ## Where the heat index comes from
 * A caller-supplied `environment.heatIndexC` wins over computing one, because upstream
 * weather APIs have humidity and temperature at higher fidelity than a single sensor
 * pair. But it is still re-banded locally rather than trusted wholesale: a provider's
 * "feels like" is not necessarily a NOAA heat index, and the flag must key off NOAA's
 * bands to mean what PRD §7.2.2 says it means.
 *
 * ## Guidance is chosen by score, not by predicate
 * See {@link HEAT_RECOMMENDATIONS}. This is the one category where the two were already
 * equivalent — its score ramps are NOAA's bands — so the four sentences are unchanged and only
 * the concrete steps are new. It is also the category that shows why an override hatch is
 * needed at all: suspected collapse scores exactly what plain extreme heat scores.
 */

import {
  computeHeatIndexC,
  computeHeatIndexF,
  celsiusToFahrenheit,
  fahrenheitToCelsius,
  HEAT_INDEX_BAND_MIN_F,
  HEAT_STRESS_FLAG_MIN_F,
  heatIndexBandForF,
  isHeatIndexOutOfDomain,
  type HeatIndexBand,
} from '../heat-index';
import type { DataQuality, EnvironmentSnapshot, RuleId } from '../types';
import { trailingStillRunMs } from '../window';
import {
  recommend,
  tieredGuidance,
  type Recommendation,
  type RecommendationLadder,
} from './recommend';
import {
  clampScore,
  interpolateScore,
  levelForScore,
  type RuleContext,
  type RuleOutcome,
  unknownOutcome,
} from './shared';

/** Top of the score ramp: 140 °F is far beyond the chart, so anything there pins. */
const SCORE_CEILING_F = 140;

/**
 * Heat's recommendation ladder (PRD §7.2.4 ext).
 *
 * The cuts are not chosen here — they are read off `scoreFor` below, which is itself read off
 * NOAA's bands: Extreme Caution maps to 40–69, Danger to 70–89, Extreme Danger to 90–100. So
 * the three tiers *are* the three NOAA bands above Caution, and the ladder is documentation of
 * a structure the rule already had rather than a new scale invented next to it.
 *
 * `ladderProblems` is what keeps that true: move a cut off a band edge and the rung starts
 * spanning a level boundary, which fails in `recommend.test.ts`.
 */
export const HEAT_RECOMMENDATIONS: RecommendationLadder = {
  ceiling: 100,
  rungs: [
    {
      minScore: 40,
      tier: 'mild',
      headline: 'Heat index is high — drink water and avoid direct sun 12–3pm.',
      actions: [
        'Drink a glass of water now, before you feel thirsty.',
        'Move any outdoor work to the early morning or evening.',
      ],
    },
    {
      minScore: 70,
      tier: 'moderate',
      headline: 'Dangerous heat — avoid going out, drink water, and stay in the shade.',
      actions: [
        'Stop outdoor work and get into shade.',
        'Drink water every 15 minutes, even without thirst.',
        'Wet your face, neck, and wrists to cool down.',
      ],
    },
    {
      minScore: 90,
      tier: 'severe',
      headline: 'Extreme heat danger — get indoors or into shade and cool down now.',
      actions: [
        'Get indoors or into deep shade immediately.',
        'Loosen clothing and cool your skin with water.',
        'Get help if you feel dizzy or confused, or stop sweating.',
      ],
    },
  ],
};

/**
 * Suspected heat collapse (PRD §7.2.5).
 *
 * Declared at `severe` rather than selected by score, because it cannot be: `collapseSuspected`
 * requires `extreme`, so its score is already 90–100 and identical to plain extreme heat. The
 * heat index cannot express the difference between dangerous weather and a person lying still
 * in it, so the wording is overridden and the tier is not — see the header of `./recommend.ts`.
 *
 * The steps are addressed to whoever is *reading the phone*, which in this state may not be the
 * person the readings came from.
 */
export const HEAT_COLLAPSE_RECOMMENDATION: Recommendation = {
  tier: 'severe',
  headline: 'Extreme heat and no movement detected — this may be heat collapse.',
  actions: [
    'Call emergency services now.',
    'Move the person into shade and cool them with water.',
    'Do not leave them alone.',
  ],
};

/** Resolved heat index for one tick, in both units, with its provenance. */
export type HeatIndexResult = {
  readonly heatIndexF: number | null;
  readonly heatIndexC: number | null;
  readonly band: HeatIndexBand | null;
  readonly outOfDomain: boolean;
  /** True when the value came from `environment.heatIndexC` rather than being derived. */
  readonly provided: boolean;
};

/**
 * Resolve the heat index once per tick, so `assess.ts` can hand the same value to the
 * heat rule, the cardiovascular multiplier, and the top-level assessment without
 * computing it three times and risking three different answers.
 */
export function resolveHeatIndex(environment: EnvironmentSnapshot | null): HeatIndexResult {
  if (environment === null) {
    return { heatIndexF: null, heatIndexC: null, band: null, outOfDomain: false, provided: false };
  }

  const provided =
    environment.heatIndexC !== undefined && Number.isFinite(environment.heatIndexC);

  const heatIndexF = provided
    ? celsiusToFahrenheit(environment.heatIndexC as number)
    : computeHeatIndexF(celsiusToFahrenheit(environment.tempC), environment.humidity);

  if (heatIndexF === null) {
    return { heatIndexF: null, heatIndexC: null, band: null, outOfDomain: false, provided };
  }

  const heatIndexC = provided
    ? (environment.heatIndexC as number)
    : computeHeatIndexC(environment.tempC, environment.humidity);

  return {
    heatIndexF,
    heatIndexC,
    band: heatIndexBandForF(heatIndexF),
    // Domain is a property of the dry-bulb temperature, not of the index, so this is
    // checked against the ambient reading even when the index was provided.
    outOfDomain: isHeatIndexOutOfDomain(celsiusToFahrenheit(environment.tempC)),
    provided,
  };
}

function metricFor(heatIndexC: number | null, outOfDomain: boolean): string {
  if (heatIndexC === null) return 'Heat index —';
  // Matches the mock's "Heat index 46°C". Rounded for display only; every comparison
  // upstream uses the unrounded value.
  const rounded = Math.round(heatIndexC);
  // Past the regression's validated domain the number is not a meaningful apparent
  // temperature, so it is shown as a floor rather than a reading.
  return outOfDomain ? `Heat index over ${rounded}°C` : `Heat index ${rounded}°C`;
}

function scoreFor(heatIndexF: number): number {
  if (heatIndexF >= HEAT_INDEX_BAND_MIN_F.extremeDanger) {
    return interpolateScore(heatIndexF, HEAT_INDEX_BAND_MIN_F.extremeDanger, SCORE_CEILING_F, 90, 100);
  }
  if (heatIndexF >= HEAT_INDEX_BAND_MIN_F.danger) {
    // 103 → 70, 125 → 89: the flagged Danger band occupies the lower half of red.
    return interpolateScore(
      heatIndexF,
      HEAT_INDEX_BAND_MIN_F.danger,
      HEAT_INDEX_BAND_MIN_F.extremeDanger,
      70,
      89,
    );
  }
  if (heatIndexF >= HEAT_INDEX_BAND_MIN_F.extremeCaution) {
    // NOAA's Extreme Caution band sits below the flag threshold, so it maps to amber —
    // a real, documented precursor rather than an invented intermediate level.
    return interpolateScore(
      heatIndexF,
      HEAT_INDEX_BAND_MIN_F.extremeCaution,
      HEAT_INDEX_BAND_MIN_F.danger,
      40,
      69,
    );
  }
  if (heatIndexF >= HEAT_INDEX_BAND_MIN_F.caution) {
    return interpolateScore(
      heatIndexF,
      HEAT_INDEX_BAND_MIN_F.caution,
      HEAT_INDEX_BAND_MIN_F.extremeCaution,
      10,
      39,
    );
  }
  return 0;
}

export function assessHeat(context: RuleContext): RuleOutcome {
  const { thresholds, heatIndexF, heatIndexBand, heatIndexOutOfDomain, extendedReadings } = context;

  if (heatIndexF === null || heatIndexBand === null) {
    return unknownOutcome(
      context.environment === null
        ? 'No local weather data yet.'
        : 'Weather data is incomplete — heat risk cannot be assessed.',
      'Heat index —',
    );
  }

  const heatIndexC = fahrenheitToCelsius(heatIndexF);
  const flagged = heatIndexF >= HEAT_STRESS_FLAG_MIN_F;
  const extreme = heatIndexF >= HEAT_INDEX_BAND_MIN_F.extremeDanger;

  /**
   * PRD §7.2.5: extreme heat index plus no motion for over ten minutes.
   *
   * `>` not `>=`, matching the spec's "> 10 min". Anchored to the newest reading, so a
   * stillness that has already ended cannot trigger it — the person got up.
   *
   * A phone left on a table also reads as stillness. That false positive is real and
   * inherent to phone-based inactivity detection; it is why this reports SOS
   * *candidacy* only, and why PRD §7.2.5 puts a 30-second user cancel in front of the
   * actual call.
   */
  const stillMs = trailingStillRunMs(extendedReadings, {
    restBandG: thresholds.fall.restBandG,
    stillnessPeakG: thresholds.fall.stillnessPeakG,
    motionRange: thresholds.plausible.motionG,
    maxGapMs: thresholds.window.maxGapMs,
  });
  const collapseSuspected = extreme && stillMs > thresholds.stillness.heatCriticalMs;

  const firedRules: RuleId[] = [];
  if (collapseSuspected) firedRules.push('heat.stillness.critical');
  if (extreme) firedRules.push('heat.index.extremeDanger');
  else if (flagged) firedRules.push('heat.index.danger');
  else if (heatIndexBand.label === 'Extreme Caution') firedRules.push('heat.index.extremeCaution');

  const observedAt = context.environment?.observedAt;
  const isStale =
    observedAt !== undefined &&
    Number.isFinite(observedAt) &&
    context.now - observedAt > thresholds.env.maxStaleMs;

  const dataQuality: DataQuality = isStale ? 'stale' : heatIndexOutOfDomain ? 'partial' : 'ok';

  const score = clampScore(scoreFor(heatIndexF));

  // Score picks the rung; the collapse case only replaces the wording at the tier that score
  // already selected. `flagged`, `extreme`, and the band label are still what decide
  // `firedRules` — they are the spec's predicates and the ladder does not touch them.
  const advice = tieredGuidance(
    collapseSuspected ? HEAT_COLLAPSE_RECOMMENDATION : recommend(HEAT_RECOMMENDATIONS, score),
    'Heat conditions are comfortable.',
  );

  return {
    level: levelForScore(score),
    flagged,
    rule: firedRules[0] ?? null,
    firedRules,
    criticalRules: collapseSuspected ? ['heat.stillness.critical'] : [],
    score,
    metric: metricFor(heatIndexC, heatIndexOutOfDomain),
    ...advice,
    dataQuality,
    // Heat is the source of environmental amplification, not a recipient of it.
    envMultiplier: 1,
  };
}
