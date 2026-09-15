/**
 * Fall rule (PRD §7.2.2): **sudden accelerometer spike followed by subsequent
 * stillness → possible fall flag.**
 *
 * The spec's shape is a two-stage sequence, and it is implemented as exactly that:
 * an impact, then stillness *after* it. Neither half flags on its own — a spike alone
 * is someone setting their phone down hard, and stillness alone is someone sitting
 * quietly.
 *
 * ## Three judgement calls the spec leaves open, and how they are resolved
 *
 * 1. **"Subsequent" does not mean "immediately".** The stillness may begin anywhere
 *    inside `stillnessWindowMs` after the impact, because people who fall commonly move
 *    for a few seconds — rolling, trying to get up — before going still. Demanding
 *    instant inactivity is a well-known way to miss real falls.
 *
 * 2. **Stillness tolerates small movement.** It is judged on the interval's central
 *    magnitude, not its peak, so a twitch does not reset the clock. The peak is bounded
 *    separately, and only to stop a free-fall-plus-impact interval from averaging out
 *    to "still" — see `RiskThresholds.fall.stillnessPeakG`.
 *
 * 3. **The flag is the event; the emergency requires it to be ongoing.** A confirmed
 *    fall flags for as long as it sits in the window, because it did happen. But
 *    `critical` additionally requires that the stillness still be unbroken at the most
 *    recent reading. Someone who fell and then walked away does not need their
 *    emergency contacts called, and PRD §7.2.5's own heat trigger ("no motion for
 *    > 10 min") shows the spec intends ongoing incapacity for SOS rather than a
 *    historical event.
 *
 * ## Why "spike" is not a peak threshold
 * The spec says "sudden accelerometer spike", but a peak alone cannot carry that. At PRD
 * §7.2.1's 30–60 s polling cadence the engine sees a *summary* of each interval, so
 * `peakG` is a maximum over ~1500–3000 raw samples, and in that statistic an ordinary
 * pocket footstrike reaches the same 2–2.5 g as a fall. The discriminator is the
 * interval *minimum*: a fall is preceded by free-fall, and walking has no
 * near-weightless phase. See `RiskThresholds.fall.freeFallMaxG`.
 *
 * Both halves of the rule are consequently limited by the aggregation interval rather
 * than by their thresholds, and the fix is architectural: once ingestion (PRD §7.2.1)
 * detects impacts per-sample and emits an explicit peak and timestamp, this rule should
 * consume that instead of re-deriving an event from a minute-long summary.
 *
 * ## The false positive this cannot rule out
 * A dropped phone that lands and stays put produces the same signature as a fall. No
 * pocket-carried accelerometer can distinguish the two, which is why this rule reports
 * SOS *candidacy* only and PRD §7.2.5 puts a 30-second user cancel in front of the
 * actual call. That cancel window is what makes a deliberately sensitive threshold the
 * right choice here.
 */

import type { DataQuality, RuleId, SensorReading } from '../types';
import {
  betweenExclusiveInclusive,
  findImpacts,
  longestStillRunMs,
  motionEstimate,
  peakG,
  trailingStillRunMs,
} from '../window';
import {
  recommend,
  tieredGuidance,
  type Recommendation,
  type RecommendationLadder,
} from './recommend';
import { levelForScore, type RuleContext, type RuleOutcome, unknownOutcome } from './shared';

const SCORE_CRITICAL = 100;
const SCORE_CONFIRMED = 85;
const SCORE_UNCONFIRMED = 50;

/**
 * Fall's recommendation ladder (PRD §7.2.4 ext).
 *
 * The one category whose scores are discrete rather than interpolated — the three constants
 * above are the only non-zero values it can produce — so the ladder here is close to a lookup
 * table, and its cuts are placed at the band edges the constants already sit inside: 50 in
 * amber, 85 and 100 in red either side of 90.
 *
 * That makes it the clearest illustration of why the rungs are keyed on score anyway. `ongoing`
 * and `isPending` still decide `criticalRules` and `dataQuality`; they no longer separately
 * decide the wording, so a future change to `SCORE_CONFIRMED` moves the card's colour and its
 * advice together instead of leaving one behind.
 */
export const FALL_RECOMMENDATIONS: RecommendationLadder = {
  ceiling: 100,
  rungs: [
    {
      minScore: 40,
      tier: 'mild',
      headline: 'Sudden movement detected, but you appear to be moving normally.',
      actions: [
        'Check yourself for pain or bruising.',
        'Carry on as normal if you feel fine.',
      ],
    },
    {
      minScore: 70,
      tier: 'moderate',
      headline: 'A possible fall was detected. Are you okay?',
      actions: [
        'Sit still for a moment before standing up.',
        'Check for pain, bleeding, or dizziness.',
        'Tell someone nearby what happened.',
      ],
    },
    {
      minScore: 90,
      tier: 'severe',
      headline: 'A fall was detected and you have not moved since — help may be needed.',
      actions: [
        'Call for help now if you are hurt or cannot get up.',
        'Do not try to stand if you feel dizzy or in pain.',
        'Stay where you are until someone reaches you.',
      ],
    },
  ],
};

/**
 * The pending case — an impact whose stillness window has not finished being observed.
 *
 * Overridden rather than scored, for the same reason as suspected heat collapse: it scores
 * `SCORE_UNCONFIRMED`, identically to an impact that was *resolved* as no fall, because the
 * score is a severity and "we do not know yet" is not one. Declared at `mild` so it agrees with
 * the tier that score selects — `ladderProblems` cannot check an override, so the tier is
 * asserted in `recommend.test.ts` instead.
 */
export const FALL_PENDING_RECOMMENDATION: Recommendation = {
  tier: 'mild',
  headline: 'Possible impact detected — checking whether you are moving.',
  actions: [
    'Stay where you are for a moment.',
    'If you are hurt, call someone now — do not wait for the app.',
  ],
};

/**
 * Steady-state fallback for the two impact branches, where a rung is always reached:
 * `SCORE_UNCONFIRMED`, `SCORE_CONFIRMED`, and `SCORE_CRITICAL` all sit above the ladder's first
 * `minScore`, which `recommend.test.ts` pins. It exists so that a mis-set ladder degrades to a
 * sentence that is still true rather than to a blank line under the status.
 */
const IMPACT_FALLBACK_GUIDANCE = 'Sudden movement detected.';

function formatG(value: number): string {
  return `${value.toFixed(1)}g`;
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

export function assessFall(context: RuleContext): RuleOutcome {
  const { readings, thresholds, now } = context;
  const { fall, plausible, window } = thresholds;

  const stillnessOptions = {
    restBandG: fall.restBandG,
    stillnessPeakG: fall.stillnessPeakG,
    motionRange: plausible.motionG,
    maxGapMs: window.maxGapMs,
  };

  const withMotion = readings.filter(
    (reading) => motionEstimate(reading, plausible.motionG) !== null,
  );

  if (withMotion.length === 0) {
    // No accelerometer coverage at all. Reporting green here without `dataQuality`
    // would claim "no fall detected" when the truth is "we were not watching".
    return unknownOutcome('Movement is not being monitored right now.', 'No motion data');
  }

  const impacts = findImpacts(readings, fall.impactG, fall.freeFallMaxG, plausible.motionG);

  // Newest impact first: if several are in the window, the most recent one determines
  // the current state. An older confirmed fall the user has since recovered from must
  // not outrank a fresh impact they are still moving after.
  const ordered = [...impacts].reverse();

  let confirmed: { readonly impact: SensorReading; readonly stillMs: number } | null = null;
  let pending: SensorReading | null = null;
  let unconfirmed: SensorReading | null = null;

  for (const impact of ordered) {
    const searchEnd = Math.min(now, impact.timestamp + fall.stillnessWindowMs);
    const after = betweenExclusiveInclusive(readings, impact.timestamp, searchEnd);
    const stillMs = longestStillRunMs(after, stillnessOptions);

    if (stillMs >= fall.stillnessMs) {
      confirmed = { impact, stillMs };
      break;
    }

    // "Not a fall" and "too early to say" are different answers, and giving the first
    // while the second is true is how a real fall gets a confident all-clear.
    //
    // The test is whether the *search window* has been fully observed, not whether
    // `stillnessMs` has elapsed. Those coincide only at fine sampling; at PRD §7.2.1's
    // 30–60 s cadence a `stillnessMs` grace period (10 s) expires before the first
    // post-impact reading even arrives, so the tick after a genuine fall reported
    // "you appear to be moving normally" with `dataQuality: 'ok'`. The loop above
    // already truncates the search at `now`, so an unfinished window is exactly the
    // condition under which the answer can still change.
    if (pending === null && now - impact.timestamp < fall.stillnessWindowMs) {
      pending = impact;
    } else if (unconfirmed === null) {
      unconfirmed = impact;
    }
  }

  const trailingStillMs = trailingStillRunMs(readings, stillnessOptions);

  if (confirmed !== null) {
    // Still unbroken at the newest reading → the person has not got up.
    const ongoing = trailingStillMs >= fall.stillnessMs;
    const impactPeak = peakG(confirmed.impact, plausible.motionG) ?? fall.impactG;

    const firedRules: RuleId[] = ['fall.impactThenStillness'];
    const score = ongoing ? SCORE_CRITICAL : SCORE_CONFIRMED;
    const advice = tieredGuidance(
      recommend(FALL_RECOMMENDATIONS, score),
      IMPACT_FALLBACK_GUIDANCE,
    );

    return {
      level: levelForScore(score),
      flagged: true,
      rule: 'fall.impactThenStillness',
      firedRules,
      criticalRules: ongoing ? ['fall.impactThenStillness'] : [],
      score,
      metric: `Impact ${formatG(impactPeak)}, still ${formatSeconds(confirmed.stillMs)}`,
      ...advice,
      dataQuality: withMotion.length < window.minSamples ? 'partial' : 'ok',
      envMultiplier: 1,
    };
  }

  const impact = pending ?? unconfirmed;
  if (impact !== null) {
    const impactPeak = peakG(impact, plausible.motionG) ?? fall.impactG;
    const isPending = pending !== null;
    const advice = tieredGuidance(
      isPending
        ? FALL_PENDING_RECOMMENDATION
        : recommend(FALL_RECOMMENDATIONS, SCORE_UNCONFIRMED),
      IMPACT_FALLBACK_GUIDANCE,
    );

    return {
      level: levelForScore(SCORE_UNCONFIRMED),
      // Advisory precursor — PRD §7.2.2's flag needs *both* halves of the sequence.
      flagged: false,
      rule: 'fall.impact.unconfirmed',
      firedRules: ['fall.impact.unconfirmed'],
      criticalRules: [],
      score: SCORE_UNCONFIRMED,
      metric: `Impact ${formatG(impactPeak)} detected`,
      ...advice,
      // Pending is genuinely incomplete data: the answer changes on the next tick.
      dataQuality: isPending ? 'partial' : 'ok',
      envMultiplier: 1,
    };
  }

  const newest = withMotion[withMotion.length - 1];
  const isStale = now - newest.timestamp > window.maxStaleMs;
  const dataQuality: DataQuality = isStale
    ? 'stale'
    : withMotion.length < window.minSamples
      ? 'partial'
      : 'ok';

  return {
    level: 'green',
    flagged: false,
    rule: null,
    firedRules: [],
    criticalRules: [],
    score: 0,
    metric: trailingStillMs >= fall.stillnessMs ? `Still ${formatSeconds(trailingStillMs)}` : 'Active',
    guidance: isStale
      ? 'Movement data is out of date.'
      : 'No fall or unusual stillness detected.',
    // Nothing fired, so there is no rung and nothing to do — see `unknownOutcome`.
    tier: null,
    actions: [],
    dataQuality,
    envMultiplier: 1,
  };
}
