/**
 * Health Connect → `SensorReading` mapping.
 *
 * The one property that matters most here is negative: a vital the record does not carry must
 * come out `undefined`, never `0`. `risk/types.ts` spells out why — the engine reads `spo2: 0`
 * as catastrophic hypoxia and would fire an emergency on it. Skin temperature is where that
 * bites in practice, because Health Connect stores it as *deltas* from an optional baseline,
 * and a delta on its own is not a temperature.
 */

import {
  mapHeartRate,
  mapOxygenSaturation,
  mapSkinTemperature,
} from '@/sensors/health-connect';

const T = '2026-09-15T10:00:00.000Z';
const T_MS = Date.parse(T);

describe('mapHeartRate', () => {
  it('fans every sample of every record out into its own reading', () => {
    const readings = mapHeartRate([
      {
        samples: [
          { time: T, beatsPerMinute: 72 },
          { time: '2026-09-15T10:00:01.000Z', beatsPerMinute: 74 },
        ],
      },
      { samples: [{ time: '2026-09-15T10:00:02.000Z', beatsPerMinute: 75 }] },
    ]);

    expect(readings).toEqual([
      { source: 'health_connect', timestamp: T_MS, hr: 72 },
      { source: 'health_connect', timestamp: T_MS + 1000, hr: 74 },
      { source: 'health_connect', timestamp: T_MS + 2000, hr: 75 },
    ]);
  });

  it('carries no other vital on the reading', () => {
    const [reading] = mapHeartRate([{ samples: [{ time: T, beatsPerMinute: 72 }] }]);
    expect(reading).not.toHaveProperty('spo2');
    expect(reading).not.toHaveProperty('skinTempC');
  });

  it('drops samples whose instant does not parse', () => {
    expect(mapHeartRate([{ samples: [{ time: 'not a date', beatsPerMinute: 72 }] }])).toEqual([]);
  });

  it('drops non-finite values rather than emitting a number the engine would trust', () => {
    expect(mapHeartRate([{ samples: [{ time: T, beatsPerMinute: Number.NaN }] }])).toEqual([]);
  });
});

describe('mapOxygenSaturation', () => {
  it('maps one instantaneous record to one reading', () => {
    expect(mapOxygenSaturation([{ time: T, percentage: 97 }])).toEqual([
      { source: 'health_connect', timestamp: T_MS, spo2: 97 },
    ]);
  });

  it('never substitutes 0 for a missing percentage', () => {
    expect(mapOxygenSaturation([{ time: T, percentage: Number.NaN }])).toEqual([]);
  });
});

describe('mapSkinTemperature', () => {
  it('adds each delta to the baseline when a baseline is present', () => {
    const readings = mapSkinTemperature([
      {
        baseline: { inCelsius: 33.5, inFahrenheit: 92.3 },
        deltas: [
          { time: T, delta: { inCelsius: 0.4, inFahrenheit: 0.72 } },
          { time: '2026-09-15T10:01:00.000Z', delta: { inCelsius: -0.2, inFahrenheit: -0.36 } },
        ],
      },
    ]);

    expect(readings).toHaveLength(2);
    expect(readings[0]).toEqual({ source: 'health_connect', timestamp: T_MS, skinTempC: 33.9 });
    expect(readings[1].skinTempC).toBeCloseTo(33.3, 6);
  });

  it('emits nothing when there is no baseline — a delta alone is not a temperature', () => {
    expect(
      mapSkinTemperature([
        { deltas: [{ time: T, delta: { inCelsius: 0.4, inFahrenheit: 0.72 } }] },
      ]),
    ).toEqual([]);
  });

  it('emits nothing for a record with a baseline and no deltas', () => {
    expect(
      mapSkinTemperature([{ baseline: { inCelsius: 33.5, inFahrenheit: 92.3 }, deltas: [] }]),
    ).toEqual([]);
  });
});
