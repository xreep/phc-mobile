/**
 * What makes an interval count as "still" for fall confirmation.
 *
 * `isStillInterval` has two clauses, and a review argued the central-magnitude clause is
 * inert — that with `stillnessPeakG` capping the peak at 1.4 g, RMS over a 30–60 s
 * interval is pinned so close to 1 g that a 0.15 g band can never bind. That algebra
 * holds only for a signal *oscillating about 1 g*, which is the everyday case. These
 * tests establish where each clause actually binds, so the thresholds are described by
 * measured behaviour instead of by argument.
 *
 * The distinction matters for tuning: a clause that cannot bind must not be documented
 * as a safety control, and a clause that binds only on sensor faults should say so.
 */

import { DEFAULT_RISK_THRESHOLDS } from '../config';
import type { MotionSummary, SensorReading } from '../types';
import { isStillInterval, longestStillRunMs, motionEstimate, trailingStillRunMs } from '../window';
import { activeMotion, at, MINUTE, reading, stillMotion } from './fixtures';

const { fall, plausible } = DEFAULT_RISK_THRESHOLDS;

function summary(peakG: number, minG: number, rmsG: number): SensorReading {
  return reading({ at: at(0), motionSummary: { peakG, minG, rmsG, sampleCount: 50 } });
}

function still(peakG: number, minG: number, rmsG: number): boolean | null {
  return isStillInterval(
    summary(peakG, minG, rmsG),
    fall.restBandG,
    fall.stillnessPeakG,
    plausible.motionG,
  );
}

describe('the peak clause is what rejects everyday movement', () => {
  it('accepts a genuinely quiet interval', () => {
    expect(still(1.05, 0.95, 1)).toBe(true);
  });

  it('rejects an interval whose peak exceeds the ceiling, however calm its average', () => {
    // A walking pocket phone: RMS 1.05 is *inside* the 0.15 g band, so the central
    // clause admits it. Only the peak ceiling rejects it. This is the case the review
    // was right about — the band alone would call a walking user still.
    expect(Math.abs(1.05 - 1)).toBeLessThanOrEqual(fall.restBandG);
    expect(still(1.8, 0.7, 1.05)).toBe(false);
  });

  it('rejects the interval containing the fall itself', () => {
    // Free-fall then impact averages back toward 1 g, so the central clause passes and
    // the peak clause is the only thing preventing the fall from confirming itself.
    expect(still(3, 0.05, 1.02)).toBe(false);
  });

  it('treats the ceiling as inclusive', () => {
    expect(still(fall.stillnessPeakG, 0.9, 1)).toBe(true);
    expect(still(fall.stillnessPeakG + 0.01, 0.9, 1)).toBe(false);
  });
});

describe('the central clause is not inert, but only binds where gravity does not dominate', () => {
  it('rejects a sustained above-gravity magnitude that stays under the peak ceiling', () => {
    // Reachable, contra the "cannot bind" claim: RMS 1.2 with peak 1.3 passes the peak
    // clause and fails the band. Physically this is sustained acceleration — a vehicle
    // pulling away, or the phone held under steady tension — not stillness.
    expect(1.3).toBeLessThanOrEqual(fall.stillnessPeakG);
    expect(still(1.3, 1.1, 1.2)).toBe(false);
  });

  it('rejects a sustained sub-gravity magnitude, which is a sensor fault', () => {
    // A device at rest on Earth reads ~1 g. A minute averaging 0.5 g is a miscalibrated
    // or stuck accelerometer, and must not be accepted as "the user is lying still".
    expect(still(1, 0.2, 0.5)).toBe(false);
  });

  it('is inclusive at the upper band edge and, by float representation, not at the lower', () => {
    // Measured, not intended: `Math.abs(0.85 - 1)` evaluates to 0.15000000000000002, so
    // the nominal lower edge lands one ULP outside an inclusive `<=`. The upper edge
    // goes the other way (0.1499999999999999) and is inside.
    //
    // Left alone deliberately. The discrepancy is 2e-17 g, far below any accelerometer's
    // resolution, so no reading can be affected by it; and at the lower edge the miss
    // resolves to "not still", which cannot cause a false emergency. Writing an epsilon
    // comparison to hide it would add a knob with no physical meaning. Pinned so that a
    // future reader sees a documented quirk rather than an apparent off-by-one.
    expect(still(1.2, 1.1, 1 + fall.restBandG)).toBe(true);
    expect(still(1.2, 0.8, 1 - fall.restBandG)).toBe(false);
    expect(Math.abs(1 - fall.restBandG - 1)).toBeGreaterThan(fall.restBandG);

    // Just inside the lower edge behaves as intended, which is what matters physically.
    expect(still(1.2, 0.8, 1 - fall.restBandG + 0.001)).toBe(true);
    expect(still(1.2, 1.1, 1 + fall.restBandG + 0.001)).toBe(false);
  });

  it('cannot bind for a signal oscillating about gravity, which is the common case', () => {
    // Pins the review's algebra as a real limitation: for magnitude varying about 1 g,
    // rms ≈ 1 + s²/2, so escaping a 0.15 g band needs a standard deviation near 0.55 g —
    // and a peak that large is rejected by the ceiling first. So on ordinary human
    // motion the band never decides the outcome, and it must not be credited as the
    // control that keeps walking out. That job belongs to `stillnessPeakG`.
    for (const s of [0.05, 0.1, 0.2, 0.35, 0.5]) {
      const rms = Math.sqrt(1 + s * s); // exact for magnitude with mean 1, sd s
      const peak = 1 + 3 * s;
      const withinBand = Math.abs(rms - 1) <= fall.restBandG;
      const withinPeak = peak <= fall.stillnessPeakG;
      // Whenever the peak clause passes, the band passes too — it adds nothing here.
      if (withinPeak) expect(withinBand).toBe(true);
    }
  });
});

describe('unobserved motion is distinguishable from stillness', () => {
  it('returns null when a reading carries no motion at all', () => {
    expect(isStillInterval(reading({ at: at(0) }), fall.restBandG, fall.stillnessPeakG, plausible.motionG))
      .toBeNull();
  });

  it('returns null for an interval nothing was sampled in, rather than true', () => {
    // `sampleCount: 0` as stillness would let a dead sensor confirm falls.
    const empty: MotionSummary = { peakG: 1, minG: 1, rmsG: 1, sampleCount: 0 };
    expect(motionEstimate(reading({ at: at(0), motionSummary: empty }), plausible.motionG)).toBeNull();
  });
});

describe('still runs ignore readings that carry no motion', () => {
  const options = {
    restBandG: fall.restBandG,
    stillnessPeakG: fall.stillnessPeakG,
    motionRange: plausible.motionG,
    maxGapMs: DEFAULT_RISK_THRESHOLDS.window.maxGapMs,
  };

  /** Motion once a minute, a heart-rate sample thirty seconds after each — the live shape. */
  function interleaved(minutes: number, motionAt: (minute: number) => MotionSummary): SensorReading[] {
    const out: SensorReading[] = [];
    for (let m = 0; m <= minutes; m += 1) {
      out.push(reading({ at: at(m * MINUTE), motionSummary: motionAt(m) }));
      if (m < minutes) out.push(reading({ at: at(m * MINUTE + 30_000), hr: 74 }));
    }
    return out;
  }

  it('longestStillRunMs spans interleaved vitals as if they were not there', () => {
    const readings = interleaved(5, () => stillMotion());
    expect(longestStillRunMs(readings, options)).toBe(5 * MINUTE);
  });

  it('trailingStillRunMs spans interleaved vitals as if they were not there', () => {
    const readings = interleaved(5, () => stillMotion());
    expect(trailingStillRunMs(readings, options)).toBe(5 * MINUTE);
  });

  it('a motion-less reading newer than the last motion reading does not zero the trailing run', () => {
    const readings = [...interleaved(3, () => stillMotion()), reading({ at: at(3 * MINUTE + 20_000), hr: 75 })];
    expect(trailingStillRunMs(readings, options)).toBe(3 * MINUTE);
  });

  it('a moving reading still breaks both runs', () => {
    const readings = interleaved(5, (m) => (m === 3 ? activeMotion() : stillMotion()));
    // Longest run is the pre-break segment (m=0..2, 2 min). Trailing only sees the
    // segment touching the newest reading — m=4..5, 1 min — since the active reading
    // at m=3 hard-breaks the backward scan and the earlier segment is no longer "ongoing".
    expect(longestStillRunMs(readings, options)).toBe(2 * MINUTE);
    expect(trailingStillRunMs(readings, options)).toBe(1 * MINUTE);
  });

  it('an accelerometer dropout longer than maxGapMs still breaks the run — the safety case', () => {
    // Motion at 0, 1, 2 min; nothing until 5 min (gap 3 min > maxGapMs 2 min); motion at 5, 6.
    // Heart-rate samples continue throughout, and must not bridge the gap.
    const readings: SensorReading[] = [];
    for (const m of [0, 1, 2, 5, 6]) readings.push(reading({ at: at(m * MINUTE), motionSummary: stillMotion() }));
    for (let m = 0; m < 6; m += 1) readings.push(reading({ at: at(m * MINUTE + 30_000), hr: 74 }));
    readings.sort((a, b) => a.timestamp - b.timestamp);

    expect(trailingStillRunMs(readings, options)).toBe(1 * MINUTE);
    expect(longestStillRunMs(readings, options)).toBe(2 * MINUTE);
  });

  it('returns 0 when no reading carries motion', () => {
    const readings = [reading({ at: at(0), hr: 70 }), reading({ at: at(MINUTE), hr: 71 })];
    expect(longestStillRunMs(readings, options)).toBe(0);
    expect(trailingStillRunMs(readings, options)).toBe(0);
  });
});
