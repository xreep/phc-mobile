/**
 * Cardiovascular rule (PRD §7.2.2):
 * **HR > 120 bpm sustained at rest, or HR < 40 bpm → cardiovascular risk flag.**
 *
 * Both predicates are implemented exactly as written — strict `>` and strict `<`, so
 * 120 and 40 themselves do not fire — but they are asymmetric in an important way that
 * the spec's phrasing dictates:
 *
 * - **Tachycardia is qualified** by "sustained at rest", so it needs a duration and a
 *   rest condition. See `RiskThresholds.heartRate` for both.
 * - **Bradycardia is unqualified.** The spec attaches no sustain or rest condition to
 *   `HR < 40`, so neither is imposed here. That is also the clinically right call:
 *   sustained-only bradycardia detection would miss the transient severe episodes that
 *   matter most, and unlike tachycardia there is no benign everyday activity that
 *   drives heart rate *down* through 40.
 *
 * The cost is that PPG dropouts can produce spurious low values. That is handled by
 * the plausibility gate and surfaced through `dataQuality` — not by quietly adding a
 * sustain requirement the spec does not have.
 */

import { HEAT_STRESS_FLAG_MIN_F } from '../heat-index';
import type { DataQuality, RuleId, SensorReading } from '../types';
import { collectSamples, latestSample, restFraction, trailingRun } from '../window';
import {
  clampScore,
  interpolateScore,
  levelForScore,
  type RuleContext,
  type RuleOutcome,
  unknownOutcome,
} from './shared';

/** Upper anchor of the resting-normal band: at or below this, nothing is rising. */
const NORMAL_HR_MAX = 100;
/** Lower anchor of the resting-normal band. Below 50 bpm is common in trained adults
 *  and during sleep, so it scores as a mild gradient rather than a warning. */
const NORMAL_HR_MIN = 50;
/** Ceiling of the tachycardia ramp — at or above this the score is pinned at its top. */
const SCORE_CEILING_HR = 180;
/** Floor of the bradycardia ramp. */
const SCORE_FLOOR_HR = 25;

function metricFor(hr: number): string {
  // Matches the mock's "HR 78 bpm".
  return `HR ${Math.round(hr)} bpm`;
}

function scoreFor(
  hr: number,
  tachycardiaAbove: number,
  bradycardiaBelow: number,
  confirmedFlag: boolean,
): number {
  if (hr < bradycardiaBelow) {
    return interpolateScore(hr, bradycardiaBelow, SCORE_FLOOR_HR, 70, 100);
  }
  if (hr > tachycardiaAbove) {
    // An unconfirmed elevation stays in the amber band: high heart rate during
    // exercise is normal physiology, and reporting it red would train users to
    // ignore the card — which is itself a safety failure.
    return confirmedFlag
      ? interpolateScore(hr, tachycardiaAbove, SCORE_CEILING_HR, 70, 100)
      : interpolateScore(hr, tachycardiaAbove, SCORE_CEILING_HR, 40, 69);
  }
  if (hr > NORMAL_HR_MAX) {
    return interpolateScore(hr, NORMAL_HR_MAX, tachycardiaAbove, 20, 39);
  }
  if (hr < NORMAL_HR_MIN) {
    return interpolateScore(hr, NORMAL_HR_MIN, bradycardiaBelow, 20, 39);
  }
  return 0;
}

export function assessCardiovascular(context: RuleContext): RuleOutcome {
  const { readings, thresholds, now, heatIndexF } = context;
  const { heartRate, plausible, window } = thresholds;
  const { samples, rejected } = collectSamples(readings, 'hr', plausible.hr);

  // Heat raises cardiac demand, so the same heart rate represents more strain
  // (PRD §7.2.3). Reported for the fusion layer, never folded into `score`.
  const envMultiplier =
    heatIndexF !== null && heatIndexF >= HEAT_STRESS_FLAG_MIN_F
      ? thresholds.env.heatFlagMultiplier
      : 1;

  const latest = latestSample(samples);
  if (latest === null) {
    return {
      ...unknownOutcome(
        rejected > 0
          ? 'Heart-rate readings were unusable — check the sensor fits snugly.'
          : 'No recent heart-rate reading.',
        'HR —',
      ),
      envMultiplier,
    };
  }

  const hr = latest.value;
  const isStale = now - latest.timestamp > window.maxStaleMs;

  // --- Bradycardia: unqualified, fires on the current value (see file header). ---
  const bradycardia = hr < heartRate.bradycardiaBelow;

  // --- Tachycardia: needs duration AND rest. ---
  const run = trailingRun(samples, (value) => value > heartRate.tachycardiaAbove, window.maxGapMs);
  const elevated = hr > heartRate.tachycardiaAbove;
  const sustained =
    run !== null &&
    run.spanMs >= heartRate.sustainedForMs &&
    run.count >= heartRate.minSustainedSamples;

  // Rest is judged only over the elevated run — whether the user was resting an hour
  // ago says nothing about whether this elevation is exertional.
  const runReadings: readonly SensorReading[] =
    run === null
      ? []
      : readings.filter((r) => r.timestamp >= run.from && r.timestamp <= run.to);
  const rest = restFraction(runReadings, heartRate.restBandG, plausible.motionG);

  const restConfirmed = rest.fraction !== null && rest.fraction >= heartRate.minRestFraction;
  const restUnknown = rest.fraction === null;

  /**
   * When motion is unobserved, "at rest" is neither confirmed nor contradicted, and
   * the flag is allowed through.
   *
   * This is the deliberate fail-sensitive direction. Requiring positive proof of rest
   * would mean any user whose device supplies no accelerometer stream — a BLE chest
   * strap with no motion channel, a denied sensor permission — could never receive
   * this flag at all, silently. Letting it fire instead costs a false alarm during
   * unmonitored exercise, and `dataQuality: 'partial'` says why the level is
   * less certain.
   */
  const restQualifies = restConfirmed || restUnknown;
  const tachycardiaFlag = sustained && restQualifies;
  const tachycardiaAdvisory = elevated && !tachycardiaFlag;

  const flagged = bradycardia || tachycardiaFlag;

  // Severity-descending. Bradycardia outranks tachycardia: at these thresholds it is
  // the more immediately dangerous of the two.
  const firedRules: RuleId[] = [];
  if (bradycardia) firedRules.push('cardiovascular.hr.bradycardia');
  if (tachycardiaFlag) firedRules.push('cardiovascular.hr.tachycardia');
  if (tachycardiaAdvisory) firedRules.push('cardiovascular.hr.tachycardia.unconfirmed');

  const dataQuality: DataQuality = isStale
    ? 'stale'
    : rejected > 0 || samples.length < window.minSamples || (elevated && restUnknown)
      ? 'partial'
      : 'ok';

  const score = clampScore(
    scoreFor(hr, heartRate.tachycardiaAbove, heartRate.bradycardiaBelow, tachycardiaFlag),
  );

  const guidance = bradycardia
    ? 'Heart rate is unusually low — sit down and get medical advice.'
    : tachycardiaFlag
      ? 'Heart rate has stayed high while you were resting — sit down and seek advice if it continues.'
      : tachycardiaAdvisory
        ? 'Heart rate is high — if you are not exercising, stop and rest.'
        : isStale
          ? 'Heart-rate reading is out of date.'
          : 'Resting heart rate looks normal.';

  return {
    level: levelForScore(score),
    flagged,
    rule: firedRules[0] ?? null,
    firedRules,
    // Neither heart-rate predicate is a PRD §7.2.5 emergency trigger on its own.
    criticalRules: [],
    score,
    metric: metricFor(hr),
    guidance,
    dataQuality,
    envMultiplier,
  };
}
