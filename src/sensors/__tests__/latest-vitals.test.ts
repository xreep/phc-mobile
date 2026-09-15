/**
 * The reading the SOS message quotes vitals from.
 *
 * In live mode the newest reading in the buffer is the motion-only summary stamped at the poll
 * instant, so `readings.at(-1)` carries no vitals at all. The SOS payload needs the newest
 * value of *each* vital independently — HR from 30 s ago, SpO₂ from 45 s ago — or the message
 * silently drops its vitals line on exactly the hardware it was built for.
 */

import { latestVitalsOf } from '@/sensors/latest-vitals';
import type { SensorReading } from '@/risk';

const NOW = 1_766_000_000_000;
const STILL = { peakG: 1.02, minG: 0.98, rmsG: 1.0, sampleCount: 1500 };

function at(offsetMs: number, fields: Partial<SensorReading>): SensorReading {
  return { source: 'health_connect', timestamp: NOW + offsetMs, ...fields };
}

describe('latestVitalsOf', () => {
  it('is null for an empty buffer', () => {
    expect(latestVitalsOf([])).toBeNull();
  });

  it('is null when no reading carries a vital', () => {
    expect(latestVitalsOf([at(0, { motionSummary: STILL })])).toBeNull();
  });

  it('composes the newest value of each vital independently, ignoring the motion-only tail', () => {
    const readings = [
      at(-120_000, { hr: 70, spo2: 99, skinTempC: 36.4 }),
      at(-45_000, { spo2: 97 }),
      at(-30_000, { hr: 82 }),
      at(0, { motionSummary: STILL }),
    ];
    expect(latestVitalsOf(readings)).toEqual({
      source: 'health_connect',
      timestamp: NOW - 30_000,
      hr: 82,
      spo2: 97,
      skinTempC: 36.4,
    });
  });

  it('omits a vital no reading carries rather than inventing one', () => {
    const composed = latestVitalsOf([at(-30_000, { hr: 82 }), at(0, { motionSummary: STILL })]);
    expect(composed).toEqual({ source: 'health_connect', timestamp: NOW - 30_000, hr: 82 });
    expect(composed).not.toHaveProperty('spo2');
    expect(composed).not.toHaveProperty('skinTempC');
    expect(composed).not.toHaveProperty('motionSummary');
  });

  it('stamps the composite with the newest contributing reading’s instant and source', () => {
    const readings: SensorReading[] = [
      { source: 'simulated', timestamp: NOW - 60_000, hr: 70 },
      { source: 'health_connect', timestamp: NOW - 10_000, spo2: 96 },
    ];
    expect(latestVitalsOf(readings)).toMatchObject({
      source: 'health_connect',
      timestamp: NOW - 10_000,
    });
  });

  it('does not assume the buffer is sorted', () => {
    const readings = [at(-10_000, { hr: 90 }), at(-60_000, { hr: 70 })];
    expect(latestVitalsOf(readings)?.hr).toBe(90);
  });

  it('returns the reading itself, unchanged, when the newest reading carries every vital', () => {
    // The simulated window's shape: `latest` and `latestVitals` must agree there.
    const full = at(0, { hr: 78, spo2: 97, skinTempC: 36.8, motionSummary: STILL });
    expect(latestVitalsOf([at(-60_000, { hr: 70, spo2: 98, skinTempC: 36.7 }), full])).toEqual({
      source: 'health_connect',
      timestamp: NOW,
      hr: 78,
      spo2: 97,
      skinTempC: 36.8,
    });
  });
});
