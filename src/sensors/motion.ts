/**
 * Phone accelerometer → `MotionSummary` (PRD §7.2.2 fall detection input).
 *
 * ## Why a fold and not a stream of `MotionVector`s
 * `risk/types.ts` explains the sampling-rate mismatch: the vitals poll is once a minute and
 * a fall impact lasts ~200 ms, so a once-a-minute vector would essentially never land on
 * it. The accelerometer is therefore sampled continuously at ~25 Hz and *folded* — peak,
 * min, rms, count — into one summary per poll interval, which the hook attaches to a reading
 * stamped at the poll instant. The engine stays a pure function of the window.
 *
 * ## Units
 * expo-sensors reports g with gravity included, the unit `MotionSummary` documents, so no
 * conversion happens here. A device at rest folds to ≈ 1.0 on every statistic.
 *
 * ## `null` means "no samples", not "still"
 * `sampleCount: 0` alongside `peakG: 0` would read as free fall. An empty interval returns
 * `null` and the hook then emits no motion for that tick, which the engine reports honestly
 * as "movement is not being monitored".
 */

import { Accelerometer } from 'expo-sensors';

import type { MotionSummary } from '@/risk';

/** 25 Hz. Well above the ~5 Hz needed to catch a 200 ms impact, cheap enough to leave on. */
export const MOTION_SAMPLE_INTERVAL_MS = 40;

export type MotionSample = { readonly x: number; readonly y: number; readonly z: number };

export type MotionAccumulator = {
  peakG: number;
  minG: number;
  sumSquares: number;
  count: number;
};

export function createAccumulator(): MotionAccumulator {
  return { peakG: 0, minG: Number.POSITIVE_INFINITY, sumSquares: 0, count: 0 };
}

export function accumulate(acc: MotionAccumulator, sample: MotionSample): void {
  const magnitude = Math.hypot(sample.x, sample.y, sample.z);
  if (!Number.isFinite(magnitude)) return;
  acc.peakG = Math.max(acc.peakG, magnitude);
  acc.minG = Math.min(acc.minG, magnitude);
  acc.sumSquares += magnitude * magnitude;
  acc.count += 1;
}

export function summarize(acc: MotionAccumulator): MotionSummary | null {
  if (acc.count === 0) return null;
  return {
    peakG: acc.peakG,
    minG: acc.minG,
    rmsG: Math.sqrt(acc.sumSquares / acc.count),
    sampleCount: acc.count,
  };
}

export type MotionFold = {
  /** The summary since the last flush (or start), then reset. `null` if nothing arrived. */
  readonly flush: () => MotionSummary | null;
  readonly stop: () => void;
};

export async function isMotionAvailable(): Promise<boolean> {
  try {
    return await Accelerometer.isAvailableAsync();
  } catch {
    return false;
  }
}

export function startMotionFold(): MotionFold {
  let acc = createAccumulator();
  Accelerometer.setUpdateInterval(MOTION_SAMPLE_INTERVAL_MS);
  const subscription = Accelerometer.addListener((sample) => accumulate(acc, sample));

  return {
    flush() {
      const summary = summarize(acc);
      acc = createAccumulator();
      return summary;
    },
    stop() {
      subscription.remove();
    },
  };
}
