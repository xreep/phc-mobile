/**
 * Accelerometer → `MotionSummary`.
 *
 * `risk/types.ts` fixes the unit as g with gravity included, so a phone lying on a table must
 * summarise to ≈ 1.0 across peak, min and rms — that is the invariant the stillness rules
 * lean on (`fall.restBandG`), and it is checked first. The second thing worth pinning is the
 * difference between "no samples" and "still": an empty interval must be `null`, because a
 * `{ peakG: 0, … sampleCount: 0 }` would read to the engine as a person in free fall.
 */

import { Accelerometer } from 'expo-sensors';

import {
  accumulate,
  createAccumulator,
  isMotionAvailable,
  MOTION_SAMPLE_INTERVAL_MS,
  startMotionFold,
  summarize,
} from '@/sensors/motion';

const available = jest.mocked(Accelerometer.isAvailableAsync);
const setInterval_ = jest.mocked(Accelerometer.setUpdateInterval);
const addListener = jest.mocked(Accelerometer.addListener);

beforeEach(() => {
  available.mockReset().mockResolvedValue(true);
  setInterval_.mockReset();
  addListener.mockReset();
});

describe('accumulator', () => {
  it('summarises a device at rest as ≈ 1.0 g on every statistic', () => {
    const acc = createAccumulator();
    for (let i = 0; i < 50; i += 1) accumulate(acc, { x: 0.01, y: -0.02, z: 0.9995 });
    const summary = summarize(acc);
    expect(summary).not.toBeNull();
    expect(summary?.peakG).toBeCloseTo(1.0, 2);
    expect(summary?.minG).toBeCloseTo(1.0, 2);
    expect(summary?.rmsG).toBeCloseTo(1.0, 2);
    expect(summary?.sampleCount).toBe(50);
  });

  it('records the impact peak and the free-fall minimum of a fall', () => {
    const acc = createAccumulator();
    accumulate(acc, { x: 0, y: 0, z: 1 });
    accumulate(acc, { x: 0, y: 0, z: 0.3 }); // near-weightless
    accumulate(acc, { x: 3, y: 0, z: 0 }); // impact
    accumulate(acc, { x: 0, y: 0, z: 1 });
    const summary = summarize(acc);
    expect(summary?.peakG).toBeCloseTo(3, 6);
    expect(summary?.minG).toBeCloseTo(0.3, 6);
    expect(summary?.sampleCount).toBe(4);
  });

  it('returns null, not zeros, for an empty interval', () => {
    expect(summarize(createAccumulator())).toBeNull();
  });

  it('ignores non-finite samples', () => {
    const acc = createAccumulator();
    accumulate(acc, { x: Number.NaN, y: 0, z: 1 });
    expect(summarize(acc)).toBeNull();
  });
});

type RawListener = (m: { x: number; y: number; z: number; timestamp: number }) => void;

describe('startMotionFold', () => {
  it('subscribes at ~25 Hz and folds delivered samples until flushed', () => {
    let listener: RawListener | null = null;
    const remove = jest.fn();
    addListener.mockImplementation((fn) => {
      listener = fn;
      return { remove } as unknown as ReturnType<typeof Accelerometer.addListener>;
    });

    const fold = startMotionFold();
    expect(setInterval_).toHaveBeenCalledWith(MOTION_SAMPLE_INTERVAL_MS);
    expect(listener).not.toBeNull();

    // TS narrows `listener` to `null` through the mockImplementation closure above (it does
    // not re-widen after a call that assigns it via a nested function), so the read here is
    // cast back to its declared type rather than left to that stale narrowing.
    (listener as RawListener | null)?.({ x: 0, y: 0, z: 1, timestamp: 0 });
    (listener as RawListener | null)?.({ x: 0, y: 0, z: 1.5, timestamp: 0.04 });

    expect(fold.flush()).toEqual({
      peakG: 1.5,
      minG: 1,
      rmsG: Math.sqrt((1 + 2.25) / 2),
      sampleCount: 2,
    });
    // Flushing resets, so the next interval starts empty.
    expect(fold.flush()).toBeNull();

    fold.stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('isMotionAvailable', () => {
  it('reflects the sensor availability check', async () => {
    available.mockResolvedValue(false);
    await expect(isMotionAvailable()).resolves.toBe(false);
  });

  it('treats a throwing availability check as unavailable', async () => {
    available.mockRejectedValue(new Error('no sensor service'));
    await expect(isMotionAvailable()).resolves.toBe(false);
  });
});
