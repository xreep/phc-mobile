/**
 * Rolling-window primitives for the Tier-1 rule engine.
 *
 * Every function here is pure and takes its thresholds as arguments — no config
 * import, no clock, no state. The rules in `rules/` compose these; this file holds
 * no policy of its own beyond the documented failure-direction choices below.
 *
 * ## Units
 * Accelerometer values are **g with gravity included**, so a stationary device reads
 * magnitude ≈ 1.0, not 0. "Deviation" throughout means `|magnitude − 1|`.
 *
 * ## The one recurring judgement call
 * Three states matter, not two: condition **met**, condition **not met**, and
 * **no data**. Collapsing "no data" into either is what produces the two worst bugs
 * in this kind of engine — a missing accelerometer silently confirming a fall, or a
 * missing one silently suppressing every alert. So predicates here return
 * `boolean | null`, with `null` meaning "unobserved", and each *rule* decides which
 * way to fail. That decision belongs to the rule, which knows the consequence; it
 * does not belong here.
 */

import type { MotionVector, NumericRange, SensorReading, TimedValue } from './types';

/** Scalar vitals on `SensorReading`. Keyed so helpers stay field-agnostic. */
export type VitalField = 'hr' | 'spo2' | 'skinTempC';

/** Magnitude at rest, in g. Gravity, by definition. */
export const REST_MAGNITUDE_G = 1;

export function isUsableNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Inclusive on both ends. */
export function isInRange(value: number, range: NumericRange): boolean {
  return value >= range.min && value <= range.max;
}

/** Euclidean norm. May return `NaN` if a component is `NaN` — callers must gate. */
export function motionMagnitudeG(motion: MotionVector): number {
  return Math.sqrt(motion.x * motion.x + motion.y * motion.y + motion.z * motion.z);
}

/**
 * What we know about motion over the interval ending at a reading's timestamp.
 * `null` from {@link motionEstimate} means the reading carries no usable motion.
 */
export type MotionEstimate = {
  /** Largest magnitude observed, g. */
  readonly peakG: number;
  /**
   * Representative central magnitude, g. This is the summary's `rmsG`, which is not
   * the arithmetic mean — RMS ≥ mean always — but for the near-constant magnitudes
   * that stillness is about, the two agree to well inside any useful threshold, and
   * RMS is what the ingestion layer can compute in one pass.
   */
  readonly centralG: number;
  /**
   * Smallest magnitude observed, g, or `null` when the interval minimum is unknown.
   *
   * `null` for a lone raw vector: a single sample's minimum is itself, which says
   * nothing about whether a free-fall phase occurred. Callers must treat `null` as
   * "unobserved" and not as "no free-fall" — see {@link findImpacts}.
   */
  readonly minG: number | null;
  readonly sampleCount: number;
  /** True when this came from a single raw vector rather than an aggregated interval,
   *  so `peakG === centralG` and sub-interval spikes are invisible. */
  readonly fromSingleSample: boolean;
};

/**
 * Prefer the aggregated summary over a lone vector: at PRD §7.2.1's 30–60 s polling
 * cadence a single vector essentially never lands on a ~200 ms fall impact, so
 * `motionSummary` is the only input that can detect one.
 *
 * `sampleCount: 0` is treated as no data, not as stillness — an interval nothing was
 * sampled in is unobserved, and reading it as "still" would let a dead sensor confirm
 * falls.
 */
export function motionEstimate(
  reading: SensorReading,
  motionRange: NumericRange,
): MotionEstimate | null {
  const summary = reading.motionSummary;
  if (
    summary !== undefined &&
    summary.sampleCount > 0 &&
    isUsableNumber(summary.peakG) &&
    isUsableNumber(summary.rmsG) &&
    isInRange(summary.peakG, motionRange) &&
    isInRange(summary.rmsG, motionRange)
  ) {
    return {
      peakG: summary.peakG,
      centralG: summary.rmsG,
      // Validated separately from peak/rms: a summary with a usable peak but a garbage
      // minimum should still be usable for everything that does not need the minimum,
      // rather than discarding the whole reading.
      minG:
        isUsableNumber(summary.minG) && isInRange(summary.minG, motionRange)
          ? summary.minG
          : null,
      sampleCount: summary.sampleCount,
      fromSingleSample: false,
    };
  }

  const motion = reading.motion;
  if (motion !== undefined) {
    const magnitude = motionMagnitudeG(motion);
    if (isUsableNumber(magnitude) && isInRange(magnitude, motionRange)) {
      return {
        peakG: magnitude,
        centralG: magnitude,
        minG: null,
        sampleCount: 1,
        fromSingleSample: true,
      };
    }
  }

  return null;
}

/**
 * Stillness for fall confirmation: central magnitude inside the rest band **and**
 * peak under an absolute ceiling.
 *
 * The peak clause does the real work. Free-fall (≈0 g) followed by impact (≫1 g) inside
 * one aggregation interval averages back to ≈1 g, so a central-only test would classify
 * the very interval containing the fall as "still"; and walking sits at RMS ≈ 1.05,
 * *inside* any useful rest band, because gravity dominates the average. Bounding the peak
 * closes both holes while leaving room for the small movements a genuinely incapacitated
 * person still makes — post-fall-inactivity detection in the literature tolerates minor
 * movement, and demanding perfect stillness misses real falls.
 *
 * The central clause is a plausibility guard rather than a movement test: for a signal
 * oscillating about 1 g it provably cannot bind before the peak ceiling does. It earns
 * its place by rejecting steady magnitudes that are *not* gravity — sustained
 * acceleration, or a stuck accelerometer reporting 0.5 g — which the peak ceiling admits.
 * See `src/risk/__tests__/stillness.test.ts`.
 */
export function isStillInterval(
  reading: SensorReading,
  restBandG: number,
  stillnessPeakG: number,
  motionRange: NumericRange,
): boolean | null {
  const estimate = motionEstimate(reading, motionRange);
  if (estimate === null) return null;
  return (
    Math.abs(estimate.centralG - REST_MAGNITUDE_G) <= restBandG &&
    estimate.peakG <= stillnessPeakG
  );
}

/**
 * "At rest" for the cardiovascular rule — strict, and deliberately peak-based.
 *
 * Walking keeps a *central* magnitude near 1 g because gravity dominates, while
 * peaking far above it; a central-only test would therefore call a walking user "at
 * rest" and report exercise tachycardia as pathological. Bounding the peak instead
 * makes each sample's verdict trustworthy. Tolerance is restored at the run level
 * via `minRestFraction`, not by loosening this.
 */
export function isAtRestSample(
  reading: SensorReading,
  restBandG: number,
  motionRange: NumericRange,
): boolean | null {
  const estimate = motionEstimate(reading, motionRange);
  if (estimate === null) return null;
  return Math.abs(estimate.peakG - REST_MAGNITUDE_G) <= restBandG;
}

/** Peak magnitude, for impact detection. `null` when motion is unobserved. */
export function peakG(reading: SensorReading, motionRange: NumericRange): number | null {
  const estimate = motionEstimate(reading, motionRange);
  return estimate === null ? null : estimate.peakG;
}

/**
 * How much of a span was spent at rest.
 *
 * `withMotion` is the denominator that matters: readings with no motion data are
 * excluded entirely rather than counted as either resting or active, so a partial
 * accelerometer outage shrinks the sample instead of biasing the fraction. When
 * `withMotion === 0` the caller has learned nothing about rest and must decide what
 * to do with that — see the cardiovascular rule.
 */
export function restFraction(
  readings: readonly SensorReading[],
  restBandG: number,
  motionRange: NumericRange,
): { readonly atRest: number; readonly withMotion: number; readonly fraction: number | null } {
  let atRest = 0;
  let withMotion = 0;

  for (const reading of readings) {
    const rest = isAtRestSample(reading, restBandG, motionRange);
    if (rest === null) continue;
    withMotion += 1;
    if (rest) atRest += 1;
  }

  return { atRest, withMotion, fraction: withMotion === 0 ? null : atRest / withMotion };
}

/** Ascending by timestamp. Copies — never mutates the caller's buffer, which may be
 *  a live ring buffer owned by the ingestion layer. */
export function sortByTimestamp(readings: readonly SensorReading[]): SensorReading[] {
  return [...readings]
    .filter((reading) => isUsableNumber(reading.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Readings in `(now − windowMs, now]`, ascending.
 *
 * Future-dated readings are dropped. Clock skew between a BLE peripheral and the
 * phone is routine, and a reading stamped an hour ahead would otherwise sit in every
 * window forever, pinning a stale flag on indefinitely.
 */
export function withinWindow(
  readings: readonly SensorReading[],
  now: number,
  windowMs: number,
): SensorReading[] {
  const oldest = now - windowMs;
  return sortByTimestamp(readings).filter(
    (reading) => reading.timestamp > oldest && reading.timestamp <= now,
  );
}

/** Readings in `(from, to]`, ascending. Assumes input already sorted. */
export function betweenExclusiveInclusive(
  readings: readonly SensorReading[],
  from: number,
  to: number,
): SensorReading[] {
  return readings.filter((reading) => reading.timestamp > from && reading.timestamp <= to);
}

/**
 * Pull one vital out of the window, dropping values that are absent, non-finite, or
 * physiologically impossible.
 *
 * `rejected` is returned rather than swallowed because the count changes the meaning
 * of the result: a category whose only readings were rejected is *unknown*, not
 * healthy, and reporting it green without saying so would be the engine's most
 * dangerous possible lie.
 */
export function collectSamples(
  readings: readonly SensorReading[],
  field: VitalField,
  range: NumericRange,
): { readonly samples: TimedValue[]; readonly rejected: number } {
  const samples: TimedValue[] = [];
  let rejected = 0;

  for (const reading of readings) {
    const value = reading[field];
    if (value === undefined) continue; // absent ≠ rejected; nothing was claimed.
    if (!isUsableNumber(value) || !isInRange(value, range)) {
      rejected += 1;
      continue;
    }
    samples.push({ value, timestamp: reading.timestamp });
  }

  return { samples, rejected };
}

export function latestSample(samples: readonly TimedValue[]): TimedValue | null {
  return samples.length === 0 ? null : samples[samples.length - 1];
}

/** A latched run of qualifying samples ending at the newest sample. */
export type TrailingRun = {
  /** `to − from`. See the note in {@link trailingRun} on why this under-reads. */
  readonly spanMs: number;
  /**
   * How many samples in the run actually satisfied `qualifies` — not how many the span
   * contains.
   *
   * The distinction only exists once hysteresis is in play, and it is what keeps a
   * minimum-sample requirement meaningful: a lone spike over the threshold followed by
   * ten minutes just under it spans ten minutes, but it is one reading's worth of
   * evidence and must not pass a "three independent readings" test.
   */
  readonly count: number;
  /** Timestamp of the oldest *qualifying* sample in the run. */
  readonly from: number;
  readonly to: number;
  /**
   * Largest qualifying value in the run — the episode's peak.
   *
   * Needed because with hysteresis the newest value is no longer the one that describes
   * the episode. Scoring a five-minute tachycardia off a newest reading of 119 bpm would
   * land in the normal band and report green while `flagged` is true.
   *
   * Deliberately only a maximum: a predicate testing a *lower* bound would want the
   * minimum instead, and no caller needs that, so adding it would be unused data.
   */
  readonly maxValue: number;
  /** The run extends to the oldest sample available, so the true duration may be
   *  longer than `spanMs` — the window simply does not reach far enough to tell. */
  readonly reachesStart: boolean;
};

/**
 * Longest run of qualifying samples **ending at the newest sample**, with optional
 * hysteresis. `null` when no such run is currently latched.
 *
 * Trailing is the whole point: a tachycardia that resolved eight minutes ago must not
 * keep firing, and only a run anchored to the newest sample expresses "still true now".
 *
 * ## Why hysteresis, and not just a threshold
 * Without it, a run breaks on *any* non-qualifying sample. Consumer optical heart-rate
 * has a resting error around 7 bpm, so a true HR of 125 produces readings that straddle
 * a 120 threshold — `129, 131, 118, 127, 133, 122, 119, 128` is eight minutes of genuine
 * sustained tachycardia whose longest strictly-consecutive run is one sample, spanning
 * 0 ms. Worse, a single low sample *on the newest reading* used to return `null` and
 * silence the rule entirely, turning five minutes of sustained tachycardia into a green
 * card. Sensor noise must not be able to erase a real episode.
 *
 * So the run is a latch, in the Schmitt-trigger sense:
 *  - `qualifies` **arms** it — at least one sample in the run must clear this, or nothing
 *    ever started and there is no episode. `count` and `maxValue` describe these samples
 *    only, so a minimum-sample requirement still measures real evidence.
 *  - `sustains` **holds** it — every sample in the run, including the newest, must clear
 *    this. Defaults to `qualifies`, which restores the strict behaviour exactly: when the
 *    two predicates are the same, every sample in the run is armed and nothing changes.
 *
 * `spanMs` is measured from the oldest *armed* sample, not from the latch boundary. That
 * matters in the other direction: a long stretch just under the arm threshold followed by
 * one sample over it is a brief spike, not a sustained episode, and measuring from the
 * latch boundary would report it as hours long.
 *
 * `spanMs` still systematically **under-reads** the real duration — the condition began
 * somewhere between the last non-sustaining sample and the first armed one, and that
 * lead-in is discarded. At 60 s polling, "sustained for 10 min" therefore needs 11
 * samples, not 10. That bias is left in deliberately: it demands slightly more evidence
 * before flagging, which is the right trade for a non-instantaneous condition like
 * tachycardia. It would be the wrong trade for fall detection, which is why falls use
 * explicit event timing instead of this helper.
 *
 * A gap larger than `maxGapMs` breaks the run: unobserved time is not qualifying time.
 */
export function trailingRun(
  samples: readonly TimedValue[],
  qualifies: (value: number) => boolean,
  maxGapMs: number,
  sustains: (value: number) => boolean = qualifies,
): TrailingRun | null {
  if (samples.length === 0) return null;

  const newest = samples[samples.length - 1];
  if (!sustains(newest.value)) return null;

  let index = samples.length - 1;
  while (index > 0) {
    const candidate = samples[index - 1];
    if (!sustains(candidate.value)) break;
    if (samples[index].timestamp - candidate.timestamp > maxGapMs) break;
    index -= 1;
  }

  // Scan the latched run for the samples that actually armed it. The oldest of those is
  // where the episode began; none at all means the values only ever sat in the hysteresis
  // band and nothing was ever triggered.
  let armedIndex = -1;
  let count = 0;
  let maxValue = 0;
  for (let i = index; i < samples.length; i += 1) {
    const value = samples[i].value;
    if (!qualifies(value)) continue;
    if (armedIndex === -1) {
      armedIndex = i;
      maxValue = value;
    } else if (value > maxValue) {
      maxValue = value;
    }
    count += 1;
  }
  if (armedIndex === -1) return null;

  const oldest = samples[armedIndex];
  return {
    spanMs: newest.timestamp - oldest.timestamp,
    count,
    from: oldest.timestamp,
    to: newest.timestamp,
    maxValue,
    // The episode reaching the very first sample in the window is the only case where
    // we cannot see when it began, so it alone means the window ran out.
    reachesStart: armedIndex === 0,
  };
}

export type StillnessOptions = {
  readonly restBandG: number;
  readonly stillnessPeakG: number;
  readonly motionRange: NumericRange;
  readonly maxGapMs: number;
};

/**
 * Longest contiguous stillness, in ms, anywhere in `readings`.
 *
 * Readings with no motion data **break** the run. That is the conservative direction
 * here: counting unobserved intervals as still would let any post-impact reading that
 * happens to lack motion data confirm a fall, manufacturing emergencies out of sensor
 * dropouts. The cost is under-detecting falls during an accelerometer outage — but
 * during such an outage the impact could not have been detected either, so nothing is
 * actually lost.
 */
export function longestStillRunMs(
  readings: readonly SensorReading[],
  options: StillnessOptions,
): number {
  const { restBandG, stillnessPeakG, motionRange, maxGapMs } = options;
  let best = 0;
  let runStart: number | null = null;
  let previous = 0;

  for (const reading of readings) {
    const still = isStillInterval(reading, restBandG, stillnessPeakG, motionRange);
    if (still !== true) {
      runStart = null;
      continue;
    }
    if (runStart === null || reading.timestamp - previous > maxGapMs) {
      runStart = reading.timestamp;
    }
    previous = reading.timestamp;
    best = Math.max(best, reading.timestamp - runStart);
  }

  return best;
}

/**
 * Stillness run that is still ongoing at the newest reading, in ms — for PRD §7.2.5's
 * "no motion for > 10 min".
 *
 * Anchored to the newest reading for the same reason as {@link trailingRun}: stillness
 * that ended is not stillness now. The span stops at the newest reading rather than
 * extending to `now`, since the time since the last reading is unobserved.
 */
export function trailingStillRunMs(
  readings: readonly SensorReading[],
  options: StillnessOptions,
): number {
  const { restBandG, stillnessPeakG, motionRange, maxGapMs } = options;
  if (readings.length === 0) return 0;

  const newest = readings[readings.length - 1];
  if (isStillInterval(newest, restBandG, stillnessPeakG, motionRange) !== true) return 0;

  let index = readings.length - 1;
  while (index > 0) {
    const candidate = readings[index - 1];
    if (isStillInterval(candidate, restBandG, stillnessPeakG, motionRange) !== true) break;
    if (readings[index].timestamp - candidate.timestamp > maxGapMs) break;
    index -= 1;
  }

  return newest.timestamp - readings[index].timestamp;
}

/**
 * Readings whose motion looks like an impact, ascending.
 *
 * Two clauses, and the second is the one doing the work:
 *
 * 1. `peakG >= impactG` — inclusive, so the configured number is the first value that
 *    fires rather than the last that does not.
 * 2. `minG <= freeFallMaxG` — the interval also dipped toward weightlessness. A fall is
 *    preceded by free-fall; a walk is not. Because `peakG` here is a maximum over a
 *    30–60 s aggregation interval, ordinary pocket footstrikes reach the same 2–2.5 g as
 *    a fall, so clause 1 alone would flag "walked across the room, then sat down".
 *
 * Clause 2 is skipped when `minG` is `null` — a lone raw vector carries no interval
 * minimum, and rejecting those would silently disable fall detection for that input
 * shape instead of narrowing it. That is the fail-open direction on purpose: a missed
 * fall is the worse error, and PRD §7.2.5's 30-second cancel absorbs a false one.
 */
export function findImpacts(
  readings: readonly SensorReading[],
  impactG: number,
  freeFallMaxG: number,
  motionRange: NumericRange,
): SensorReading[] {
  return readings.filter((reading) => {
    const estimate = motionEstimate(reading, motionRange);
    if (estimate === null || estimate.peakG < impactG) return false;
    return estimate.minG === null || estimate.minG <= freeFallMaxG;
  });
}
