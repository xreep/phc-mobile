/**
 * `summarizeTrend` / `dailySummary` — pure aggregation over a reading list.
 *
 * No provider, no store, no clock: every case here builds a `SensorReading[]` by hand and
 * checks the numbers that come back, the same discipline `src/risk/window.ts`'s own tests use.
 * A few cases are load-bearing rather than routine:
 *
 * - **Boundary inclusion.** `readSince` on the store is inclusive at both ends
 *   (`src/store/__tests__/store-contract.ts`), so a reading timestamped exactly at `from` or
 *   `to` must not be silently dropped by the bucketing on top of it.
 * - **Plausibility rejection.** A physically impossible artefact must not appear in `min`/`max`
 *   or move a bucket's mean — the same gate `collectSamples` applies to the risk engine, applied
 *   here without that gate being on `@/risk`'s public surface.
 * - **`current` is the newest sample**, not the last one appended — the fixtures below append
 *   out of order specifically to catch a `current = readings[readings.length - 1]` bug.
 */

import { DEFAULT_RISK_THRESHOLDS } from '@/risk';
import type { SensorReading } from '@/risk';

import { dailySummary, summarizeTrend } from '../aggregate';

const T0 = 1_766_000_000_000;
const HOUR = 60 * 60 * 1000;

function hr(offsetMs: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp: T0 + offsetMs, hr: bpm };
}

function spo2(offsetMs: number, pct: number): SensorReading {
  return { source: 'health_connect', timestamp: T0 + offsetMs, spo2: pct };
}

describe('summarizeTrend', () => {
  it('returns null when nothing plausible falls in range', () => {
    expect(summarizeTrend([], 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 })).toBeNull();
    expect(
      summarizeTrend([hr(-HOUR, 70)], 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 }),
    ).toBeNull();
  });

  it('includes a reading exactly at `from` and exactly at `to`', () => {
    const readings = [hr(0, 60), hr(24 * HOUR, 90)];
    const summary = summarizeTrend(readings, 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 });

    expect(summary).not.toBeNull();
    expect(summary!.sampleCount).toBe(2);
    expect(summary!.min).toBe(60);
    expect(summary!.max).toBe(90);
    // The `to`-instant sample belongs to the last bucket, not a 25th out-of-range one.
    expect(summary!.points[0]).toBe(60);
    expect(summary!.points[23]).toBe(90);
  });

  it('excludes readings outside the range', () => {
    const readings = [hr(-HOUR, 999), hr(0, 60), hr(24 * HOUR + 1, 999)];
    const summary = summarizeTrend(readings, 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 });

    expect(summary!.sampleCount).toBe(1);
    expect(summary!.max).toBe(60);
  });

  it('leaves a bucket null when nothing fell in it, rather than reporting zero', () => {
    const readings = [hr(0, 60), hr(5 * HOUR, 70)];
    const summary = summarizeTrend(readings, 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 });

    expect(summary!.points[0]).toBe(60);
    expect(summary!.points[1]).toBeNull();
    expect(summary!.points[5]).toBe(70);
    expect(summary!.points[6]).toBeNull();
  });

  it('rejects a physiologically implausible artefact and does not let it move min/max/avg', () => {
    const readings = [hr(0, 60), hr(HOUR, 999), hr(2 * HOUR, 70)];
    const summary = summarizeTrend(readings, 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 });

    // 999 > DEFAULT_RISK_THRESHOLDS.plausible.hr.max (300) — rejected outright.
    expect(readings[1].hr).toBeGreaterThan(DEFAULT_RISK_THRESHOLDS.plausible.hr.max);
    expect(summary!.sampleCount).toBe(2);
    expect(summary!.max).toBe(70);
    expect(summary!.avg).toBe(65);
    expect(summary!.points[1]).toBeNull();
  });

  it('reports `current` as the newest sample by timestamp, not the last one appended', () => {
    // Appended out of order on purpose.
    const readings = [hr(10 * HOUR, 80), hr(0, 60), hr(5 * HOUR, 70)];
    const summary = summarizeTrend(readings, 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 });

    expect(summary!.current).toBe(80);
  });

  it('computes avg at full precision, not rounded', () => {
    const readings = [hr(0, 60), hr(HOUR, 61)];
    const summary = summarizeTrend(readings, 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 });

    expect(summary!.avg).toBeCloseTo(60.5, 10);
  });

  it('means multiple samples inside one bucket instead of keeping only one', () => {
    const readings = [hr(0, 60), hr(10 * 60 * 1000, 70), hr(20 * 60 * 1000, 80)];
    const summary = summarizeTrend(readings, 'hr', { from: T0, to: T0 + 24 * HOUR, buckets: 24 });

    expect(summary!.points[0]).toBe(70); // (60 + 70 + 80) / 3
  });

  it('carries the field and its unit', () => {
    const summary = summarizeTrend([spo2(0, 97)], 'spo2', {
      from: T0,
      to: T0 + 24 * HOUR,
      buckets: 24,
    });

    expect(summary!.field).toBe('spo2');
    expect(summary!.unit).toBe('%');
  });
});

describe('dailySummary', () => {
  const DAY = 24 * HOUR;

  it('reports null for a vital with no plausible samples in the day', () => {
    const summary = dailySummary([], { dayStart: T0, dayEnd: T0 + DAY });
    expect(summary.hr).toBeNull();
    expect(summary.spo2).toBeNull();
    expect(summary.skinTempC).toBeNull();
    expect(summary.elevatedMinutes).toBe(0);
  });

  it('summarizes each vital independently over the day', () => {
    const readings = [hr(0, 60), hr(HOUR, 80), spo2(0, 96), spo2(HOUR, 98)];
    const summary = dailySummary(readings, { dayStart: T0, dayEnd: T0 + DAY });

    expect(summary.hr).toEqual({ min: 60, max: 80, avg: 70, sampleCount: 2 });
    expect(summary.spo2).toEqual({ min: 96, max: 98, avg: 97, sampleCount: 2 });
    expect(summary.skinTempC).toBeNull();
  });

  it('counts elevatedMinutes using the config thresholds, not a literal', () => {
    const { tachycardiaAbove } = DEFAULT_RISK_THRESHOLDS.heartRate;
    const { flagBelow } = DEFAULT_RISK_THRESHOLDS.spo2;

    const readings = [
      hr(0, tachycardiaAbove + 1), // elevated minute 0
      hr(30_000, tachycardiaAbove), // same minute, does not qualify on its own but minute already counted
      spo2(60_000, flagBelow - 1), // elevated minute 1 (different vital)
      hr(2 * 60_000, tachycardiaAbove - 1), // minute 2: not elevated
    ];

    const summary = dailySummary(readings, { dayStart: T0, dayEnd: T0 + DAY });
    expect(summary.elevatedMinutes).toBe(2);
  });

  it('does not count a minute whose only readings sit exactly at the flag lines (strict inequalities)', () => {
    const { tachycardiaAbove } = DEFAULT_RISK_THRESHOLDS.heartRate;
    const { flagBelow } = DEFAULT_RISK_THRESHOLDS.spo2;

    const readings = [hr(0, tachycardiaAbove), spo2(0, flagBelow)];
    const summary = dailySummary(readings, { dayStart: T0, dayEnd: T0 + DAY });
    expect(summary.elevatedMinutes).toBe(0);
  });

  it('excludes readings outside [dayStart, dayEnd]', () => {
    const readings = [hr(-1, 65), hr(0, 60), hr(DAY + 1, 65)];
    const summary = dailySummary(readings, { dayStart: T0, dayEnd: T0 + DAY });
    expect(summary.hr).toEqual({ min: 60, max: 60, avg: 60, sampleCount: 1 });
  });
});
