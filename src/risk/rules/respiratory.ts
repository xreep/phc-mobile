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
 *
 * ## The air-quality advisory (PS 26181 §3b; PRD §7.2.3 / §7.2.4 ext)
 * Air quality reaches this rule by two separate routes, and keeping them separate is the
 * design:
 *
 * - **`envMultiplier`** — the PRD §7.2.3 amplification, ramped from `env.aqiNeutralBelow` to
 *   `env.aqiSevereAbove`. Reported, never applied; see `RiskThresholds.env`. Unchanged by
 *   anything below.
 * - **`respiratory.aqi.*`** — an advisory precursor in the sense `heat.index.extremeCaution`
 *   established. Above `env.aqiAdvisoryAbove` the EPA band the AQI falls in sets a configured
 *   score, and the card's level, score, and guidance follow it. It is listed in `firedRules`
 *   and it is never `flagged` and never critical: PRD §7.2.2's respiratory flag is SpO₂ < 92 %
 *   and nothing else may claim it. The multiplier used to be the only way bad air reached
 *   this card, and since it is reported rather than applied, the card stayed green in
 *   hazardous air. The advisory is what makes the card react.
 *
 * The two combine by `max`: the score is the larger of the SpO₂ score and the advisory
 * score, and the level is derived from that as always. `firedRules` keeps SpO₂ first — the
 * spec's rules outrank an advisory whatever the scores say — so `rule` is a PRD flag whenever
 * one fired. Guidance follows `rule`: a card driven by blood oxygen reads the SpO₂ ladder,
 * one driven by the air reads {@link RESPIRATORY_AQI_RECOMMENDATIONS}.
 *
 * ## The advisory applies only to a current observation
 * A weather observation past `env.maxStaleMs` produces no advisory at all, rather than a
 * stale-flagged one, because the multiplier already records "there was bad air at some
 * point" and an amber card demanding the windows be closed on hour-old data is a false
 * instruction. The heat rule keeps firing on stale data and marks the outcome `stale`; the
 * two differ on purpose — a heat flag is a PRD §7.2.2 rule the engine may not suppress, an
 * advisory is not.
 */

import { aqiBandLabelFor, AQI_BAND_MAX, type AqiBandLabel } from '../aqi-bands';
import type { DataQuality, EnvironmentSnapshot, RuleId } from '../types';
import { collectSamples, latestSample } from '../window';
import { recommend, tieredGuidance, type RecommendationLadder } from './recommend';
import {
  CATEGORY_LABELS,
  clampScore,
  interpolateScore,
  isEnvironmentStale,
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

/**
 * The air-quality ladder — respiratory's second, the way cardiovascular has one per direction.
 *
 * One ladder cannot serve both inputs: SpO₂ 91 % and AQI 320 both score at the floor of red,
 * and "sit upright and breathe slowly" is the wrong sentence for one of them. So the driving
 * rule chooses the ladder and the score chooses the rung, exactly as `TACHYCARDIA_` and
 * `BRADYCARDIA_RECOMMENDATIONS` do.
 *
 * The rung floors are the three advisory scores in `config.ts` (40 / 55 / 70), one per EPA
 * band, so the wording names the band the score came from. `aqi-advisory.test.ts` pins that
 * pairing; `ladderProblems` pins that no rung crosses a level boundary. The ceiling is the
 * hazardous score: this ladder cannot produce more, and a ceiling of 100 would hide that.
 *
 * The AQI itself is not in the headline. The ladder is static so `ladderProblems` can check it,
 * and the number is already on the metric line directly above — `SpO₂ 98% · AQI 168
 * (Unhealthy)` — where a reader looks for a reading rather than for advice.
 *
 * The wording follows EPA's own cautionary statements for each band, translated into the steps
 * a phone user can take. "People with asthma or heart disease" is named in the mild rung
 * because at 151–200 EPA's statement singles them out; from 201 the statement is addressed to
 * everyone and the rung says so.
 */
export const RESPIRATORY_AQI_RECOMMENDATIONS: RecommendationLadder = {
  ceiling: 70,
  rungs: [
    {
      minScore: 40,
      tier: 'mild',
      headline:
        'Air quality is unhealthy — limit prolonged outdoor exertion and keep windows closed.',
      actions: [
        'Keep windows closed and stay indoors where you can.',
        'Wear a well-fitting mask outdoors if you must go out.',
        'If you have asthma or heart disease, stay indoors and keep your inhaler to hand.',
      ],
    },
    {
      minScore: 55,
      tier: 'moderate',
      headline: 'Air quality is very unhealthy — avoid outdoor exertion and stay indoors.',
      actions: [
        'Stay indoors with windows closed; run an air purifier if you have one.',
        'Wear a well-fitting mask (N95/FFP2) for any time outside.',
        'Get medical advice if you feel breathless or your chest feels tight.',
      ],
    },
    {
      minScore: 70,
      tier: 'severe',
      headline: 'Air quality is hazardous — stay indoors and avoid all outdoor activity.',
      actions: [
        'Stay indoors, keep windows and doors closed, and avoid going out at all.',
        'Wear a well-fitting mask (N95/FFP2) if you cannot avoid going outside.',
        'Get medical help if you have trouble breathing, wheezing, or chest pain.',
      ],
    },
  ],
};

/** Which advisory fired, and what it scores. */
type AqiAdvisory = {
  readonly rule: RuleId;
  readonly score: number;
  /** Rounded for display; every comparison used the unrounded value. */
  readonly aqi: number;
  readonly label: AqiBandLabel;
};

/**
 * The advisory for one tick, or `null` when none applies.
 *
 * `null` in four cases, each of which must leave the outcome byte-identical to the
 * pre-advisory engine: no environment, no usable AQI, AQI at or below the advisory line, or an
 * observation past `env.maxStaleMs`. The band is the EPA band of the AQI itself — not derived
 * from the line — so lowering the line extends the lowest rung downward rather than
 * inventing a band.
 */
function aqiAdvisoryFor(
  environment: EnvironmentSnapshot | null,
  now: number,
  env: RuleContext['thresholds']['env'],
): AqiAdvisory | null {
  const aqi = environment?.aqi;
  if (aqi === undefined || !Number.isFinite(aqi) || aqi < 0) return null;
  if (aqi <= env.aqiAdvisoryAbove) return null;
  if (isEnvironmentStale(environment, now, env.maxStaleMs)) return null;

  const rounded = Math.round(aqi);
  const label = aqiBandLabelFor(aqi);
  if (aqi <= AQI_BAND_MAX.unhealthy) {
    return { rule: 'respiratory.aqi.unhealthy', score: env.aqiUnhealthyScore, aqi: rounded, label };
  }
  if (aqi <= AQI_BAND_MAX.veryUnhealthy) {
    return {
      rule: 'respiratory.aqi.veryUnhealthy',
      score: env.aqiVeryUnhealthyScore,
      aqi: rounded,
      label,
    };
  }
  return { rule: 'respiratory.aqi.hazardous', score: env.aqiHazardousScore, aqi: rounded, label };
}

function metricFor(spo2: number | null, advisory: AqiAdvisory | null): string {
  // Matches the mock's "SpO₂ 97%" formatting so the card is visually unchanged when no
  // advisory is in play. The AQI is appended only when its advisory fired — a card in clean
  // air has no reason to grow a second number.
  const base = spo2 === null ? 'SpO₂ —' : `SpO₂ ${Math.round(spo2)}%`;
  if (advisory === null) return base;
  return `${base} · AQI ${advisory.aqi} (${advisory.label})`;
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

/** Whether `rule` is one of the air-quality advisories, i.e. reads the air-quality ladder. */
function isAqiAdvisory(rule: RuleId | null): boolean {
  return rule !== null && rule.startsWith('respiratory.aqi.');
}

export function assessRespiratory(context: RuleContext): RuleOutcome {
  const { readings, thresholds, now } = context;
  const { samples, rejected } = collectSamples(readings, 'spo2', thresholds.plausible.spo2);
  const envMultiplier = airQualityMultiplier(context.environment?.aqi, thresholds.env);
  const advisory = aqiAdvisoryFor(context.environment, now, thresholds.env);

  const latest = latestSample(samples);
  if (latest === null) {
    if (advisory === null) {
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

    // No SpO₂ but hazardous air: the advisory stands on its own. `partial` rather than
    // `missing`, because one of the two inputs is present — and not `unknownOutcome`, because
    // a card that stayed silent green about hazardous air for want of a band would be the
    // exact failure the advisory exists to prevent.
    const score = clampScore(advisory.score);
    return {
      level: levelForScore(score),
      flagged: false,
      rule: advisory.rule,
      firedRules: [advisory.rule],
      criticalRules: [],
      score,
      metric: metricFor(null, advisory),
      ...tieredGuidance(
        recommend(RESPIRATORY_AQI_RECOMMENDATIONS, score),
        'Blood oxygen is in the normal range.',
      ),
      dataQuality: 'partial',
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

  // Severity-descending, and the spec's rules before the advisory regardless of score: a
  // PRD §7.2.2 flag is never presented behind an air-quality note.
  const firedRules: RuleId[] = [];
  if (criticalConfirmed) firedRules.push('respiratory.spo2.critical');
  if (flagged) firedRules.push('respiratory.spo2.low');
  if (advisory !== null) firedRules.push(advisory.rule);
  const rule = firedRules[0] ?? null;

  // The SpO₂ reading's own quality. The advisory does not change it: `stale` here still
  // means the blood-oxygen reading behind the metric is out of date, even when the air is
  // what set the level.
  const dataQuality: DataQuality = isStale
    ? 'stale'
    : rejected > 0 || samples.length < thresholds.window.minSamples
      ? 'partial'
      : 'ok';

  const spo2Score = clampScore(scoreFor(spo2, thresholds.spo2.flagBelow, thresholds.spo2.criticalBelow));
  const score = advisory === null ? spo2Score : Math.max(spo2Score, clampScore(advisory.score));

  // `criticalConfirmed` still decides the SOS trigger below and no longer decides the wording —
  // an unconfirmed 82 % now reads as the severe rung its score already put it in.
  //
  // The ladder follows the driving rule. When an SpO₂ rule fired its score is at least 70,
  // which is at least any advisory score, so `score` is the SpO₂ score and the SpO₂ ladder
  // reads it. When only the advisory fired, `score` is the advisory score and the air-quality
  // ladder reads it. Either way the tier is chosen by the same score the level was.
  const advice = tieredGuidance(
    recommend(isAqiAdvisory(rule) ? RESPIRATORY_AQI_RECOMMENDATIONS : RESPIRATORY_RECOMMENDATIONS, score),
    isStale ? 'Blood-oxygen reading is out of date.' : 'Blood oxygen is in the normal range.',
  );

  return {
    // Derived from the score so the card and the fusion layer can never disagree.
    level: levelForScore(score),
    flagged,
    rule,
    firedRules,
    criticalRules: criticalConfirmed ? ['respiratory.spo2.critical'] : [],
    score,
    metric: metricFor(spo2, advisory),
    ...advice,
    dataQuality,
    envMultiplier,
  };
}

/** Exported for the assessment's category label lookup. */
export const RESPIRATORY_LABEL = CATEGORY_LABELS.respiratory;
