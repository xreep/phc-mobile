/**
 * Respiratory rule (PRD §7.2.2): **SpO₂ < 92 % → respiratory risk flag.**
 *
 * Implemented exactly as specified — strict `<`, on the most recent usable reading,
 * with no sustain requirement. 92.0 % is therefore *not* flagged; 91.9 % is. That
 * discontinuity is the threshold doing its job and must not be smoothed away.
 *
 * The one thing layered on top is PRD §7.2.5's critical escalation at SpO₂ < 85 %,
 * which additionally requires confirmation across samples — see
 * `RiskThresholds.spo2.criticalMinSamples` for why the flag is instant but the
 * emergency is not.
 */

import type { DataQuality, RuleId } from '../types';
import { collectSamples, latestSample } from '../window';
import { recommend, tieredGuidance, type RecommendationLadder } from './recommend';
import {
  CATEGORY_LABELS,
  clampScore,
  interpolateScore,
  levelForScore,
  type RuleContext,
  type RuleOutcome,
  unknownOutcome,
} from './shared';

/** Above this, oxygenation is unambiguously normal and scores 0. */
const NORMAL_SPO2 = 97;
/** Floor of the critical ramp: at or below this the score is pinned at 100. */
const SCORE_FLOOR_SPO2 = 80;

/**
 * Respiratory's recommendation ladder (PRD §7.2.4 ext).
 *
 * Two rungs, and the missing `mild` is the point: this category has no amber. `scoreFor` sends
 * everything above the 92 % threshold into green and everything below it into red, because
 * PRD §7.2.2's flag is a hard `<` with no advisory band in front of it. A ladder that invented
 * a mild rung to fill the gap would be inventing a level the rule cannot produce.
 *
 * **This is also the fix for a real disagreement.** The rungs used to be selected by predicate:
 * `criticalConfirmed` for the top sentence, `flagged` for the other. `criticalConfirmed`
 * additionally requires `spo2.criticalMinSamples` readings below 85 % — so a single reading of
 * 82 % scored 92/100, coloured the card **Alert**, and printed "sit upright, rest, and breathe
 * slowly" underneath. Selecting on the score instead means the confirmation requirement still
 * governs the SOS trigger, where it belongs, and no longer governs what the user is told.
 */
export const RESPIRATORY_RECOMMENDATIONS: RecommendationLadder = {
  ceiling: 100,
  rungs: [
    {
      minScore: 70,
      tier: 'moderate',
      headline: 'Blood oxygen is below normal — sit upright, rest, and breathe slowly.',
      actions: [
        'Sit upright and stop what you are doing.',
        'Breathe slowly through your nose for a few minutes.',
        'Get medical advice if it does not come back up.',
      ],
    },
    {
      minScore: 90,
      tier: 'severe',
      headline: 'Blood oxygen is critically low — get medical help now.',
      actions: [
        'Call for medical help now.',
        'Sit upright — do not lie flat.',
        'Stay with someone who can act if you cannot.',
      ],
    },
  ],
};

function metricFor(spo2: number): string {
  // Matches the mock's "SpO₂ 97%" formatting so the card is visually unchanged.
  return `SpO₂ ${Math.round(spo2)}%`;
}

/**
 * Place SpO₂ on the shared 0–100 scale.
 *
 * The band edges line up with the rule boundaries on purpose: 92 % lands at the top
 * of green (39) and anything under it starts at the bottom of red (70), so
 * `levelForScore` reproduces the specified flag rather than approximating it.
 */
function scoreFor(spo2: number, flagBelow: number, criticalBelow: number): number {
  if (spo2 >= NORMAL_SPO2) return 0;
  if (spo2 >= flagBelow) {
    // 97 → 0, 92 → 39. Still green, but a rising score gives the fusion layer the
    // gradient it needs; a flat 0 up to the threshold would hide a real decline.
    return interpolateScore(spo2, NORMAL_SPO2, flagBelow, 0, 39);
  }
  if (spo2 >= criticalBelow) {
    // 92 → 70, 85 → 89: the whole flagged-but-not-critical range sits inside red.
    return interpolateScore(spo2, flagBelow, criticalBelow, 70, 89);
  }
  return interpolateScore(spo2, criticalBelow, SCORE_FLOOR_SPO2, 90, 100);
}

/**
 * Respiratory amplification from air quality (PRD §7.2.3). Ramps linearly between the
 * neutral and severe AQI bounds. Reported, never applied — see `RiskThresholds.env`.
 */
function airQualityMultiplier(aqi: number | undefined, env: RuleContext['thresholds']['env']): number {
  if (aqi === undefined || !Number.isFinite(aqi)) return 1;
  if (aqi <= env.aqiNeutralBelow) return 1;
  const ratio = Math.min(
    1,
    (aqi - env.aqiNeutralBelow) / Math.max(1, env.aqiSevereAbove - env.aqiNeutralBelow),
  );
  return 1 + ratio * (env.aqiMaxMultiplier - 1);
}

export function assessRespiratory(context: RuleContext): RuleOutcome {
  const { readings, thresholds, now } = context;
  const { samples, rejected } = collectSamples(readings, 'spo2', thresholds.plausible.spo2);
  const envMultiplier = airQualityMultiplier(context.environment?.aqi, thresholds.env);

  const latest = latestSample(samples);
  if (latest === null) {
    // No usable value. Green is the only level available, so the honest signal is
    // `dataQuality` — a caller that renders green here without checking it is
    // presenting "we have no idea" as "you are fine".
    return {
      ...unknownOutcome(
        rejected > 0
          ? 'Blood-oxygen readings were unusable — check the sensor fits snugly.'
          : 'No recent blood-oxygen reading.',
          'SpO₂ —',
      ),
      envMultiplier,
    };
  }

  const spo2 = latest.value;
  const isStale = now - latest.timestamp > thresholds.window.maxStaleMs;
  const flagged = spo2 < thresholds.spo2.flagBelow;

  // Confirmation for the emergency path only. Counting *all* in-window samples below
  // the critical bound rather than requiring them to be consecutive is deliberate:
  // desaturation with an intermittent sensor produces a broken series, and demanding
  // an unbroken run there would suppress exactly the case that matters.
  const criticalSamples = samples.filter((s) => s.value < thresholds.spo2.criticalBelow).length;
  const criticalConfirmed =
    spo2 < thresholds.spo2.criticalBelow &&
    criticalSamples >= thresholds.spo2.criticalMinSamples;

  const firedRules: RuleId[] = [];
  if (criticalConfirmed) firedRules.push('respiratory.spo2.critical');
  if (flagged) firedRules.push('respiratory.spo2.low');

  const dataQuality: DataQuality = isStale
    ? 'stale'
    : rejected > 0 || samples.length < thresholds.window.minSamples
      ? 'partial'
      : 'ok';

  const score = clampScore(scoreFor(spo2, thresholds.spo2.flagBelow, thresholds.spo2.criticalBelow));

  // `criticalConfirmed` still decides the SOS trigger below and no longer decides the wording —
  // an unconfirmed 82 % now reads as the severe rung its score already put it in.
  const advice = tieredGuidance(
    recommend(RESPIRATORY_RECOMMENDATIONS, score),
    isStale ? 'Blood-oxygen reading is out of date.' : 'Blood oxygen is in the normal range.',
  );

  return {
    // Derived from the score so the card and the fusion layer can never disagree.
    level: levelForScore(score),
    flagged,
    rule: firedRules[0] ?? null,
    firedRules,
    criticalRules: criticalConfirmed ? ['respiratory.spo2.critical'] : [],
    score,
    metric: metricFor(spo2),
    ...advice,
    dataQuality,
    envMultiplier,
  };
}

/** Exported for the assessment's category label lookup. */
export const RESPIRATORY_LABEL = CATEGORY_LABELS.respiratory;
