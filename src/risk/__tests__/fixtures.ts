/**
 * Shared builders for the risk-engine tests.
 *
 * Not a test suite — `jest.config.js` requires a `.test`/`.spec` infix precisely so
 * this file can live here.
 *
 * Everything is built from {@link T0}, a fixed epoch. No test may call `Date.now()`:
 * the engine takes `now` as an argument specifically so its duration rules are
 * deterministic, and a real clock would reintroduce the flakiness that design avoids.
 */

import type { MotionSummary, MotionVector, SensorReading } from '../types';

/** Fixed reference instant (2023-11-14T22:13:20Z). Arbitrary but constant. */
export const T0 = 1_700_000_000_000;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** Epoch ms at `offsetMs` after {@link T0}. */
export function at(offsetMs: number): number {
  return T0 + offsetMs;
}

/**
 * Motion summary for a stationary device: magnitude pinned at exactly 1 g, which is
 * what an accelerometer reads at rest because gravity is included.
 */
export function stillMotion(sampleCount = 50): MotionSummary {
  return { peakG: 1, minG: 1, rmsG: 1, sampleCount };
}

/** Motion summary for a moving device — peak above the rest band, central near 1 g. */
export function activeMotion(peakG = 1.8, sampleCount = 50): MotionSummary {
  return { peakG, minG: 0.7, rmsG: 1.05, sampleCount };
}

/**
 * Motion summary for an impact. `minG` is near zero because a fall is preceded by
 * free-fall, and `rmsG` stays near 1 g — which is exactly the averaging artifact that
 * `fall.stillnessPeakG` exists to catch, so it is reproduced faithfully here rather
 * than idealized away.
 */
export function impactMotion(peakG: number, sampleCount = 50): MotionSummary {
  return { peakG, minG: 0.05, rmsG: 1.02, sampleCount };
}

/** Raw vector with the given magnitude, aligned to one axis. */
export function vector(magnitudeG: number): MotionVector {
  return { x: 0, y: 0, z: magnitudeG };
}

export type ReadingSpec = {
  readonly at: number;
  readonly hr?: number;
  readonly spo2?: number;
  readonly skinTempC?: number;
  readonly motion?: MotionVector;
  readonly motionSummary?: MotionSummary;
  readonly source?: SensorReading['source'];
};

/**
 * Build one reading. Absent vitals stay absent rather than defaulting to 0 — the
 * engine treats `undefined` as "no signal" and `0` as catastrophic, so a fixture that
 * filled in zeros would silently test the wrong thing.
 */
export function reading(spec: ReadingSpec): SensorReading {
  const result: {
    source: SensorReading['source'];
    timestamp: number;
    hr?: number;
    spo2?: number;
    skinTempC?: number;
    motion?: MotionVector;
    motionSummary?: MotionSummary;
  } = {
    source: spec.source ?? 'simulated',
    timestamp: spec.at,
  };
  if (spec.hr !== undefined) result.hr = spec.hr;
  if (spec.spo2 !== undefined) result.spo2 = spec.spo2;
  if (spec.skinTempC !== undefined) result.skinTempC = spec.skinTempC;
  if (spec.motion !== undefined) result.motion = spec.motion;
  if (spec.motionSummary !== undefined) result.motionSummary = spec.motionSummary;
  return result;
}

export type SeriesSpec = {
  /** Number of readings. */
  readonly count: number;
  /** Spacing between readings. */
  readonly everyMs: number;
  /** Timestamp of the **last** reading. Series are built backwards from the newest
   *  because every rule is anchored to "now", so that is the end that matters. */
  readonly endingAt: number;
  readonly hr?: number;
  readonly spo2?: number;
  readonly skinTempC?: number;
  readonly motionSummary?: MotionSummary;
};

/** Evenly spaced readings, ascending, all carrying the same values. */
export function series(spec: SeriesSpec): SensorReading[] {
  const readings: SensorReading[] = [];
  for (let index = spec.count - 1; index >= 0; index -= 1) {
    readings.push(
      reading({
        at: spec.endingAt - index * spec.everyMs,
        ...(spec.hr !== undefined ? { hr: spec.hr } : {}),
        ...(spec.spo2 !== undefined ? { spo2: spec.spo2 } : {}),
        ...(spec.skinTempC !== undefined ? { skinTempC: spec.skinTempC } : {}),
        motionSummary: spec.motionSummary ?? stillMotion(),
      }),
    );
  }
  return readings;
}

/**
 * A healthy person at rest: six minutes of unremarkable readings, one per minute.
 * The baseline for every "no flags" assertion, and the thing each single-flag test
 * mutates exactly one value of.
 */
export function healthySeries(endingAt = at(0)): SensorReading[] {
  return series({ count: 6, everyMs: MINUTE, endingAt, hr: 72, spo2: 98, skinTempC: 34 });
}
