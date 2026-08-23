/**
 * Dehydration advisory (PRD §7.2.4 extension):
 * **sustained heat exposure + heart rate drifting above the window's own baseline.**
 *
 * ## This is an advisory, and the containment is deliberate
 * Dehydration is not one of the six PRD §7.2.2 flags and not one of PRD §7.2.5's three SOS
 * triggers, so this rule never sets `flagged` and never contributes a `criticalRule`. It
 * produces a card, a score, and guidance — nothing that can place an emergency call. The
 * ceiling is a red *level* at most, reachable only when the drift is severe **and** the heat
 * index has reached NOAA's Danger band, which is the one combination where telling somebody
 * "stop and drink now" in the strongest available terms is the correct output.
 *
 * ## Why the rise is measured against a baseline rather than a number
 * Cardiovascular drift is the physiological signature here: fluid loss reduces plasma
 * volume, so stroke volume falls, and heart rate climbs to maintain cardiac output. The
 * *magnitude* of that climb is informative; the absolute heart rate is not. A trained adult
 * resting at 52 bpm who drifts to 66 is in the same trouble as a patient resting at 84 who
 * drifts to 98, and no single absolute threshold reports both — one of them is always either
 * missed or permanently flagged. So the comparison is against the oldest slice of this
 * user's own window, which needs no profile, no storage, and no history beyond the buffer
 * the engine already holds.
 *
 * That choice has a cost, stated plainly: a drift that began *before* the window opened is
 * partly baked into the baseline, so the measured rise understates the real one. The rule is
 * therefore late rather than wrong on slow-onset dehydration, and it errs toward silence,
 * which is the right direction for an advisory that competes for attention with the flags.
 *
 * ## Why the drift run is latched, not consecutive
 * Same reason as the tachycardia rule, and the same evidence: consumer optical HR carries
 * roughly 7 bpm of resting error, so a true 10 bpm drift emits readings on both sides of the
 * arm threshold, and a strictly-consecutive run would almost never accumulate. `trailingRun`
 * arms at `baseline + riseBpm`, holds above `baseline + riseReleaseBpm`, and counts only the
 * armed readings toward `minSustainedSamples` — so the evidence bar is unchanged and one
 * noisy sample on the newest reading cannot silence a real drift.
 *
 * ## Why rest is checked at all
 * A heart rate 12 bpm above baseline while walking uphill is exertion, not fluid loss. Rest
 * is judged only over the drift run, using the same band and the same fail-sensitive policy
 * as the cardiovascular rule: unobserved motion neither confirms nor contradicts rest, and
 * the advisory is allowed through with `dataQuality: 'partial'` saying why.
 */

import { HEAT_INDEX_BAND_MIN_F } from '../heat-index';
import type { DataQuality, RuleId, SensorReading } from '../types';
import {
  betweenExclusiveInclusive,
  collectSamples,
  latestSample,
  restFraction,
  trailingRun,
} from '../window';
import {
  CATEGORY_LABELS,
  clampScore,
  interpolateScore,
  levelForScore,
  type RuleContext,
  type RuleOutcome,
  unknownOutcome,
} from './shared';

export const DEHYDRATION_LABEL = CATEGORY_LABELS.dehydration;

/** Ceiling of the drift ramp — at or above this the score is pinned at the band's top. */
const SCORE_CEILING_RISE_BPM = 35;

function metricFor(rise: number, baseline: number): string {
  const signed = rise >= 0 ? `+${Math.round(rise)}` : `${Math.round(rise)}`;
  return `HR ${signed} bpm vs baseline ${Math.round(baseline)}`;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function assessDehydration(context: RuleContext): RuleOutcome {
  const { extendedReadings, thresholds, now, heatIndexF, heatIndexOutOfDomain } = context;
  const { dehydration, heartRate, plausible, window } = thresholds;

  // No environmental amplification. The heat load is already one half of the conjunction
  // below, so multiplying the result by it as well would count the same evidence twice.
  const envMultiplier = 1;

  if (heatIndexF === null) {
    return {
      ...unknownOutcome(
        'Waiting for weather data before judging heat-related fluid loss.',
        'Hydration —',
      ),
      envMultiplier,
    };
  }

  const readings = betweenExclusiveInclusive(
    extendedReadings,
    now - dehydration.windowMs,
    now,
  );
  const { samples, rejected } = collectSamples(readings, 'hr', plausible.hr);
  const latest = latestSample(samples);

  if (latest === null) {
    return {
      ...unknownOutcome(
        rejected > 0
          ? 'Heart-rate readings were unusable, so fluid loss cannot be estimated.'
          : 'No recent heart-rate reading to compare against.',
        'Hydration —',
      ),
      envMultiplier,
    };
  }

  const isStale = now - latest.timestamp > window.maxStaleMs;
  const exposed = heatIndexF >= dehydration.exposureMinF;

  // ---- Baseline: the oldest `baselineFraction` of the window's samples ----
  //
  // Split by sample *count* rather than by elapsed time. A fixed `baselineMs` would hold a
  // cadence-dependent number of samples — zero of them at a coarse poll interval — which is
  // this engine's recurring silent-failure shape. A count split is the same fraction of the
  // span at every cadence, and floors at `minBaselineSamples` so the mean is never one point.
  const baselineCount = Math.max(
    dehydration.minBaselineSamples,
    Math.floor(samples.length * dehydration.baselineFraction),
  );
  const baselineSamples = samples.slice(0, baselineCount);
  // Strictly fewer, so at least one sample is left for the drift run to be found in.
  const haveBaseline = baselineSamples.length >= dehydration.minBaselineSamples &&
    baselineSamples.length < samples.length;
  const baseline = haveBaseline ? mean(baselineSamples.map((s) => s.value)) : null;

  // ---- Drift: a latched run above the baseline, in the newest slice only ----
  const driftSamples = haveBaseline ? samples.slice(baselineCount) : [];
  const run =
    baseline === null
      ? null
      : trailingRun(
          driftSamples,
          (value) => value > baseline + dehydration.riseBpm,
          window.maxGapMs,
          (value) => value > baseline + dehydration.riseReleaseBpm,
        );

  const sustained =
    run !== null &&
    run.spanMs >= dehydration.sustainedForMs &&
    run.count >= dehydration.minSustainedSamples;

  // Rest over the drift run only — whether the user was resting before it started says
  // nothing about whether *this* elevation is exertional.
  const runReadings: readonly SensorReading[] =
    run === null
      ? []
      : readings.filter((r) => r.timestamp >= run.from && r.timestamp <= run.to);
  const rest = restFraction(runReadings, heartRate.restBandG, plausible.motionG);
  const restConfirmed = rest.fraction !== null && rest.fraction >= heartRate.minRestFraction;
  const restUnknown = rest.fraction === null;
  // Fail-sensitive, matching `cardiovascular.ts`: a device with no motion channel must not
  // be silently excluded from this advisory forever.
  const restQualifies = restConfirmed || restUnknown;

  const drifting = exposed && sustained && restQualifies;
  const rise = run !== null && baseline !== null ? run.maxValue - baseline : 0;
  // "Severe" needs both halves at strength. Drift alone in the Extreme Caution band is a
  // reason to drink water, not a reason for a red card.
  const severe =
    drifting &&
    rise >= dehydration.severeRiseBpm &&
    heatIndexF >= HEAT_INDEX_BAND_MIN_F.danger;

  const firedRules: RuleId[] = [];
  if (severe) firedRules.push('dehydration.cardiovascularDrift.severe');
  if (drifting) firedRules.push('dehydration.cardiovascularDrift');

  const dataQuality: DataQuality = isStale
    ? 'stale'
    : rejected > 0 ||
        samples.length < window.minSamples ||
        !haveBaseline ||
        heatIndexOutOfDomain ||
        (drifting && restUnknown)
      ? 'partial'
      : 'ok';

  const score = clampScore(
    severe
      ? // Red band, but capped below the 90+ the specified flags reserve for themselves —
        // an advisory should never outrank `heat.index.extremeDanger` on the same screen.
        interpolateScore(rise, dehydration.severeRiseBpm, SCORE_CEILING_RISE_BPM, 70, 85)
      : drifting
        ? // Amber, split so the Danger band reads worse than Extreme Caution at the same drift.
          heatIndexF >= HEAT_INDEX_BAND_MIN_F.danger
          ? interpolateScore(rise, dehydration.riseBpm, dehydration.severeRiseBpm, 55, 69)
          : interpolateScore(rise, dehydration.riseBpm, dehydration.severeRiseBpm, 40, 54)
        : // Nothing sustained. Heat exposure on its own is the heat card's business, so this
          // one stays at zero rather than double-reporting it.
          0,
  );

  const guidance = severe
    ? 'Strong signs of fluid loss in dangerous heat — stop, get into shade, and drink water now.'
    : drifting
      ? 'Heart rate is drifting up in the heat, which often means fluid loss — drink water and rest.'
      : isStale
        ? 'Heart-rate reading is out of date, so fluid loss cannot be estimated.'
        : exposed
          ? 'Heat exposure is high but your heart rate is steady — keep drinking water.'
          : 'No signs of heat-related fluid loss.';

  const metric =
    baseline === null
      ? `HR ${Math.round(latest.value)} bpm, baseline pending`
      : metricFor(run === null ? latest.value - baseline : rise, baseline);

  return {
    level: levelForScore(score),
    // Never a PRD §7.2.2 flag — see the file header. This is the whole containment.
    flagged: false,
    rule: firedRules[0] ?? null,
    firedRules,
    // Never a PRD §7.2.5 trigger either: dehydration is not in `CRITICAL_RULES`.
    criticalRules: [],
    score,
    metric,
    guidance,
    dataQuality,
    envMultiplier,
  };
}
