/**
 * Pins the EPA AQI conversion at every breakpoint boundary.
 *
 * These tests are the provenance record for the numbers in `aqi.ts`. A breakpoint table
 * transcribed from memory is wrong in a way that no amount of reading the code reveals —
 * the arithmetic is valid either way, only the constants are off — so each band's two
 * edges are asserted against the published index values rather than against whatever the
 * implementation currently returns.
 *
 * The other job is the scale itself. The whole reason this module exists is that OWM's
 * 1–5 index and the engine's 100/300 thresholds live on different scales, so the
 * alignment between a category's colour and `env.aqiNeutralBelow` is asserted against the
 * engine's own config instead of being left as a claim in a comment.
 */

import {
  aqiCategoryFor,
  aqiFromOwmIndex,
  aqiFromPm10,
  aqiFromPm25,
  estimateAqi,
} from '@/environment/aqi';
import { DEFAULT_RISK_THRESHOLDS as T } from '@/risk';

describe('PM2.5 sub-index (2024 EPA breakpoints)', () => {
  // Concentration → index, at both edges of all six bands.
  const boundaries: readonly [number, number][] = [
    [0, 0],
    [9.0, 50],
    [9.1, 51],
    [35.4, 100],
    [35.5, 101],
    [55.4, 150],
    [55.5, 151],
    [125.4, 200],
    [125.5, 201],
    [225.4, 300],
    [225.5, 301],
    [325.4, 500],
  ];

  it.each(boundaries)('%f µg/m³ → AQI %i', (concentration, expected) => {
    expect(aqiFromPm25(concentration)).toBe(expected);
  });

  it('uses the 2024 "Good" ceiling, not the pre-2024 one', () => {
    // 12.0 was the old boundary. Under the current table it is squarely into Moderate,
    // and getting this wrong would under-report the most common band in Indian cities.
    expect(aqiFromPm25(12.0)).toBeGreaterThan(50);
    expect(aqiCategoryFor(aqiFromPm25(12.0) as number).label).toBe('Moderate');
  });

  it('reports the scale ceiling above the top breakpoint rather than failing', () => {
    expect(aqiFromPm25(325.5)).toBe(500);
    expect(aqiFromPm25(1_000)).toBe(500);
  });
});

describe('PM10 sub-index', () => {
  const boundaries: readonly [number, number][] = [
    [0, 0],
    [54, 50],
    [55, 51],
    [154, 100],
    [155, 101],
    [254, 150],
    [255, 151],
    [354, 200],
    [355, 201],
    [424, 300],
    [425, 301],
    [604, 500],
  ];

  it.each(boundaries)('%i µg/m³ → AQI %i', (concentration, expected) => {
    expect(aqiFromPm10(concentration)).toBe(expected);
  });

  it('reports the scale ceiling above the top breakpoint', () => {
    expect(aqiFromPm10(605)).toBe(500);
  });
});

describe('truncation closes the gaps between bands', () => {
  // EPA quotes PM2.5 bands as 0.0–9.0 then 9.1–35.4, so 9.05 falls in neither. Without
  // the specified truncation a real reading lands in the gap and returns null, which the
  // caller would read as "no AQI available" — a live input silently disappearing on
  // certain values, which is the failure shape this codebase keeps hitting.
  it.each([
    [9.05, 50],
    [9.09, 50],
    [35.45, 100],
    [55.49, 150],
  ])('PM2.5 %f µg/m³ truncates into the lower band → %i', (concentration, expected) => {
    expect(aqiFromPm25(concentration)).toBe(expected);
  });

  it('truncates PM10 to whole µg/m³', () => {
    expect(aqiFromPm10(54.9)).toBe(50);
    expect(aqiFromPm10(154.9)).toBe(100);
  });
});

describe('categories', () => {
  it.each([
    [0, 'Good', 'green'],
    [50, 'Good', 'green'],
    [51, 'Moderate', 'green'],
    [100, 'Moderate', 'green'],
    [101, 'Unhealthy for Sensitive Groups', 'amber'],
    [150, 'Unhealthy for Sensitive Groups', 'amber'],
    [151, 'Unhealthy', 'red'],
    [200, 'Unhealthy', 'red'],
    [201, 'Very Unhealthy', 'red'],
    [300, 'Very Unhealthy', 'red'],
    [301, 'Hazardous', 'red'],
    [500, 'Hazardous', 'red'],
  ])('AQI %i is %s / %s', (aqi, label, level) => {
    expect(aqiCategoryFor(aqi)).toEqual({ label, level });
  });

  it('never emits a level the risk cards cannot render', () => {
    // `RiskCard`'s LEVEL_LABEL lookup renders `undefined` for anything outside these
    // three, so a fourth level would ship a blank chip rather than throw.
    for (let aqi = 0; aqi <= 600; aqi += 1) {
      expect(['green', 'amber', 'red']).toContain(aqiCategoryFor(aqi).level);
    }
  });

  it('turns amber exactly where the engine stops treating air as unremarkable', () => {
    // The claim in aqi.ts's comment, asserted against the engine's own config so the two
    // cannot drift apart silently.
    expect(aqiCategoryFor(T.env.aqiNeutralBelow).level).toBe('green');
    expect(aqiCategoryFor(T.env.aqiNeutralBelow + 1).level).toBe('amber');
  });

  it('is red well before the engine reaches full amplification', () => {
    expect(aqiCategoryFor(T.env.aqiSevereAbove).level).toBe('red');
    expect(aqiCategoryFor(T.env.aqiSevereAbove).label).toBe('Very Unhealthy');
    expect(aqiCategoryFor(T.env.aqiSevereAbove + 1).label).toBe('Hazardous');
  });
});

describe('estimateAqi', () => {
  it('reports the worst sub-index, not an average', () => {
    // Clean PM2.5 must not be allowed to mask dangerous PM10. Averaging these two
    // sub-indices (11 and 173) would give ~92 — Moderate, a green card — for air that is
    // genuinely Unhealthy.
    const estimate = estimateAqi({ pm2_5: 2, pm10: 300 });
    expect(estimate).toEqual({
      aqi: 173,
      category: { label: 'Unhealthy', level: 'red' },
      basis: 'pm10',
    });
    expect(aqiFromPm25(2)).toBe(11);
  });

  it('names PM2.5 as the basis when it dominates', () => {
    const estimate = estimateAqi({ pm2_5: 79.8, pm10: 90 });
    expect(estimate?.basis).toBe('pm2_5');
    expect(estimate?.aqi).toBe(168);
    expect(estimate?.category.label).toBe('Unhealthy');
  });

  it('ignores the gaseous components rather than misreading their units', () => {
    // o3/no2/so2/co arrive as instantaneous µg/m³; their EPA sub-indices are defined on
    // ppb/ppm over multi-hour averages. Converting them here would be a unit error that
    // produced a confident wrong number, so a payload with only gases has no AQI.
    expect(estimateAqi({ o3: 180, no2: 90, so2: 40, co: 4_000 })).toBeNull();
  });

  it('falls back to OWM’s 1–5 band only when no PM data is usable', () => {
    expect(estimateAqi({}, 5)).toEqual({
      aqi: 250,
      category: { label: 'Very Unhealthy', level: 'red' },
      basis: 'owm_index',
    });

    // …and prefers the pollutant-derived value whenever it has one, even if the band
    // disagrees. A 1–5 band cannot override a real concentration.
    expect(estimateAqi({ pm2_5: 79.8 }, 1)?.basis).toBe('pm2_5');
    expect(estimateAqi({ pm2_5: 79.8 }, 1)?.aqi).toBe(168);
  });

  it('maps every OWM band into the matching category', () => {
    expect(aqiCategoryFor(aqiFromOwmIndex(1) as number).label).toBe('Good');
    expect(aqiCategoryFor(aqiFromOwmIndex(2) as number).label).toBe('Moderate');
    expect(aqiCategoryFor(aqiFromOwmIndex(3) as number).label).toBe(
      'Unhealthy for Sensitive Groups',
    );
    expect(aqiCategoryFor(aqiFromOwmIndex(4) as number).label).toBe('Unhealthy');
    expect(aqiCategoryFor(aqiFromOwmIndex(5) as number).label).toBe('Very Unhealthy');
    expect(aqiFromOwmIndex(0)).toBeNull();
    expect(aqiFromOwmIndex(6)).toBeNull();
  });

  it('returns null rather than a number for absent or nonsense input', () => {
    // The engine reads a missing AQI as "no amplification", which is the correct
    // behaviour for unknown air. Substituting 0 would instead assert clean air.
    expect(estimateAqi(null)).toBeNull();
    expect(estimateAqi(undefined)).toBeNull();
    expect(estimateAqi({})).toBeNull();
    expect(estimateAqi({ pm2_5: Number.NaN })).toBeNull();
    expect(estimateAqi({ pm2_5: -1 })).toBeNull();
    expect(estimateAqi({ pm2_5: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('treats a genuine zero concentration as clean air, not as missing', () => {
    expect(estimateAqi({ pm2_5: 0 })).toEqual({
      aqi: 0,
      category: { label: 'Good', level: 'green' },
      basis: 'pm2_5',
    });
  });
});
