/**
 * Fatigue advisory (PRD §7.2.4 extension):
 * **prolonged unbroken stillness + a heart rate that stays elevated through it.**
 *
 * ## Why the conjunction is the whole rule
 * Neither half means anything alone, and that is the point. Sitting still for twenty minutes
 * is what most people do most of the day. A heart rate of 94 bpm is unremarkable after
 * stairs, a hot bus, or a cup of coffee. But a heart rate that stays above 90 across fifteen
 * minutes during which the accelerometer says the body did not move is not explained by
 * exertion, because there was none — what remains is heat load, illness, poor sleep, or
 * exhaustion, all of which are things an outdoor worker should be told about.
 *
 * The bar therefore sits at 90 bpm, well below PRD §7.2.2's 120 bpm tachycardia flag. That is
 * not a weakened version of the flag; it is a different measurement. 90 bpm on its own is
 * inside normal variation and would be noise. 90 bpm *conditioned on fifteen minutes of
 * stillness* is a signal the tachycardia rule cannot produce, and the two never overlap in
 * what they report.
 *
 * ## Containment
 * Fatigue is not among the six PRD §7.2.2 flags and not among PRD §7.2.5's three SOS
 * triggers, so this rule never sets `flagged`, never contributes a `criticalRule`, and is
 * **capped at amber** — see {@link MAX_FATIGUE_SCORE}. There is no evidence available here
 * that justifies a red card: the most this can ever mean is "you look worn out", and a rule
 * that shouted about that would train users to ignore the cards that do matter.
 *
 * ## The honest false positive
 * A phone left face-up on a table reports perfect stillness indefinitely, and if a wrist
 * sensor is still streaming heart rate, this rule sees stillness plus elevation and fires.
 * There is no way to distinguish "person sitting motionless" from "device sitting motionless"
 * from a single accelerometer, so this is not fixed here — it is bounded: the cap at amber
 * means the cost of the false positive is one caution card, and the guidance is phrased as a
 * suggestion rather than an instruction. `stillness.heatCriticalMs` faces the same ambiguity
 * and PRD §7.2.5 answers it with a 30-second user cancel; an advisory needs no such gate
 * because it does nothing.
 *
 * ## Stillness means the same thing everywhere in the engine
 * This reuses `fall.restBandG` and `fall.stillnessPeakG` through `trailingStillRunMs` rather
 * than defining its own notion of "not moving". The peak ceiling is the clause that does the
 * real work: walking sits at an RMS magnitude near 1.05 g, comfortably inside any useful rest
 * band, and only its peaks give it away.
 */

import type { DataQuality, RuleId } from '../types';
import {
  betweenExclusiveInclusive,
  collectSamples,
  latestSample,
  trailingRun,
  trailingStillRunMs,
} from '../window';
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

export const FATIGUE_LABEL = CATEGORY_LABELS.fatigue;

/**
 * Hard ceiling on this category's score — the top of the amber band.
 *
 * Enforced with a `Math.min` rather than by choosing gentle ramp anchors, so that no future
 * edit to the ramps can quietly promote an advisory to red. `assess.ts` takes the overall
 * level from the worst category, so a red here would put the Dashboard's headline at Alert on
 * evidence that amounts to "sitting still with a raised pulse".
 */
const MAX_FATIGUE_SCORE = 69;

/** Ceiling of the heart-rate ramp — at or above this the score is pinned at the cap. */
const SCORE_CEILING_HR = 115;

/**
 * Fatigue's recommendation ladder (PRD §7.2.4 ext).
 *
 * Two rungs, both amber, and `ceiling: 69` is {@link MAX_FATIGUE_SCORE} written where a test can
 * read it. This is the other half of the argument against three global tier cuts: a `severe` rung
 * at 90 would be permanently unreachable in this category, so the ladder would advertise three
 * tiers and deliver one. Subdividing the band it *can* occupy gives the user two real answers
 * instead — the difference between "take a break" and "stop for the day", which at a 25 bpm-wide
 * ramp is a difference the score can actually resolve.
 *
 * The cut at 55 lands near 103 bpm sustained through the stillness window. That is not a round
 * number and is not meant to be; it is the midpoint of a range whose ends were fixed by the
 * containment argument in the file header.
 */
export const FATIGUE_RECOMMENDATIONS: RecommendationLadder = {
  ceiling: MAX_FATIGUE_SCORE,
  rungs: [
    {
      minScore: 40,
      tier: 'mild',
      headline:
        'Your heart rate has stayed high while you have been resting — take a proper break and drink water.',
      actions: [
        'Sit somewhere cool and rest for fifteen minutes.',
        'Drink water, and eat something if you have not.',
      ],
    },
    {
      minScore: 55,
      tier: 'moderate',
      headline:
        'Your heart rate has stayed well above resting for a while — stop for the day if you can.',
      actions: [
        'Stop working and rest properly, not just sitting down.',
        'Drink water and get out of the heat.',
        'Ask someone to check on you if this does not ease off.',
      ],
    },
  ],
};

function minutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

export function assessFatigue(context: RuleContext): RuleOutcome {
  const { extendedReadings, thresholds, now } = context;
  const { fatigue, fall, plausible, window } = thresholds;

  // No environmental amplification: nothing in this rule reads the weather, and inventing a
  // multiplier for it would put an unexplained number in the fusion layer's hands.
  const envMultiplier = 1;

  const readings = betweenExclusiveInclusive(extendedReadings, now - fatigue.windowMs, now);
  const { samples, rejected } = collectSamples(readings, 'hr', plausible.hr);
  const latest = latestSample(samples);

  if (latest === null) {
    return {
      ...unknownOutcome(
        rejected > 0
          ? 'Heart-rate readings were unusable, so fatigue cannot be estimated.'
          : 'No recent heart-rate reading.',
        'Activity —',
      ),
      envMultiplier,
    };
  }

  const hr = latest.value;
  const isStale = now - latest.timestamp > window.maxStaleMs;

  // ---- Half one: trailing stillness, measured with the fall rule's definition ----
  const stillMs = trailingStillRunMs(readings, {
    restBandG: fall.restBandG,
    stillnessPeakG: fall.stillnessPeakG,
    motionRange: plausible.motionG,
    maxGapMs: window.maxGapMs,
  });
  // `>=`, not `>`. At a 60 s cadence with a 60 s freshness lag the achievable trailing span
  // lands exactly on the threshold, so strict `>` would make this unsatisfiable at the
  // slowest cadence PRD §7.2.1 allows — the engine's recurring silent-failure shape.
  // `fatigue.test.ts` asserts the reachability at each cadence rather than trusting this note.
  const inactive = stillMs >= fatigue.inactiveForMs;

  // ---- Half two: a latched run of elevated heart rate ----
  //
  // Latched for the same reason as the tachycardia and drift runs: at ~7 bpm of resting
  // sensor error a true 92 bpm straddles the 90 bpm arm threshold, and a strictly consecutive
  // run would almost never accumulate. Only readings above the arm threshold count toward
  // `minSustainedSamples`, so the evidence bar is unchanged by the hysteresis.
  const run = trailingRun(
    samples,
    (value) => value > fatigue.restingHrAbove,
    window.maxGapMs,
    (value) => value > fatigue.restingHrReleaseAbove,
  );
  const elevated =
    run !== null &&
    run.spanMs >= fatigue.sustainedForMs &&
    run.count >= fatigue.minSustainedSamples;

  const fatigued = inactive && elevated;

  const firedRules: RuleId[] = [];
  if (fatigued) firedRules.push('fatigue.inactiveElevatedHr');

  // Motion is not optional for this rule the way it is for the cardiovascular flag: without
  // it there is no stillness half at all, so the conjunction is unanswerable rather than
  // merely less certain. Reporting `partial` says the card is silent for want of data.
  const motionUnknown = stillMs === 0 && readings.every((r) => r.motionSummary === undefined && r.motion === undefined);

  const dataQuality: DataQuality = isStale
    ? 'stale'
    : rejected > 0 || samples.length < window.minSamples || motionUnknown
      ? 'partial'
      : 'ok';

  // Score the episode's peak, not the newest reading: under hysteresis the newest sample can
  // sit below the arm threshold while a twelve-minute run qualifies, and scoring `hr` would
  // then produce a green card beside a fired rule.
  const peak = run === null ? hr : run.maxValue;
  const score = clampScore(
    Math.min(
      MAX_FATIGUE_SCORE,
      fatigued
        ? interpolateScore(peak, fatigue.restingHrAbove, SCORE_CEILING_HR, 40, MAX_FATIGUE_SCORE)
        : // One half without the other is ordinary life. A gradient here would put a
          // permanent amber tint on every desk worker and every brisk walk.
          0,
    ),
  );

  const advice = tieredGuidance(
    recommend(FATIGUE_RECOMMENDATIONS, score),
    isStale
      ? 'Heart-rate reading is out of date, so fatigue cannot be estimated.'
      : inactive
        ? 'You have been still for a while and your heart rate is settled.'
        : 'No signs of fatigue.',
  );

  const metric = inactive
    ? `HR ${Math.round(hr)} bpm, still ${minutes(stillMs)} min`
    : `HR ${Math.round(hr)} bpm, active`;

  return {
    level: levelForScore(score),
    // Never a PRD §7.2.2 flag — see the file header.
    flagged: false,
    rule: firedRules[0] ?? null,
    firedRules,
    // Never a PRD §7.2.5 trigger: fatigue is not in `CRITICAL_RULES`.
    criticalRules: [],
    score,
    metric,
    ...advice,
    dataQuality,
    envMultiplier,
  };
}
