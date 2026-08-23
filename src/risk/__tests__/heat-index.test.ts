/**
 * NOAA/NWS heat-index tests.
 *
 * Two distinct jobs, kept separate on purpose:
 *
 * 1. **Agreement with the published NWS chart**, at a ±1.5 °F tolerance. The chart is
 *    printed as integers and the Rothfusz regression carries a stated ±1.3 °F error, so
 *    a tighter tolerance would be asserting false precision.
 * 2. **Regression lock** on exact outputs. If someone drops the averaging step or a
 *    coefficient, chart agreement alone might still pass within tolerance — these pin
 *    the arithmetic so a silent change cannot slip through.
 *
 * There used to be a third: a `mock environment data is physically self-consistent` block
 * checking that the `ENVIRONMENT` constant's hardcoded `heatIndexC` matched the temperature
 * and humidity written beside it. That constant is gone — the Environment screen fetches live
 * observations now — and the drift it guarded against is no longer possible, because both the
 * service and the test fixture *derive* the index from their own inputs. The end-to-end
 * agreement between what the screen prints and what the engine scores is asserted in
 * `src/environment/__tests__/service.test.ts` instead, which is also what removed this file's
 * only import from `@/constants` — a dependency the engine is not supposed to have at all.
 */

import {
  celsiusToFahrenheit,
  computeHeatIndexC,
  computeHeatIndexF,
  fahrenheitToCelsius,
  HEAT_INDEX_BAND_MIN_F,
  HEAT_INDEX_MAX_VALID_TEMP_F,
  HEAT_STRESS_FLAG_MIN_F,
  heatIndexBandForC,
  heatIndexBandForF,
  isHeatIndexOutOfDomain,
  isHeatStressFlaggedF,
  rothfuszHeatIndexF,
} from '../heat-index';

describe('heat index — agreement with the published NWS chart', () => {
  // [dry-bulb °F, RH %, chart value °F]
  const CHART: readonly [number, number, number][] = [
    [80, 40, 80],
    [84, 50, 85],
    [86, 90, 105],
    [90, 40, 91],
    [90, 70, 106],
    [94, 60, 110],
    [96, 45, 104],
    [100, 40, 109],
    [110, 40, 136],
  ];

  it.each(CHART)('T=%i°F RH=%i%% ≈ %i°F', (tempF, humidity, expected) => {
    const actual = computeHeatIndexF(tempF, humidity);
    expect(actual).not.toBeNull();
    expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(1.5);
  });
});

describe('heat index — exact arithmetic', () => {
  it('averages the simple formula with the dry-bulb temperature below 80°F', () => {
    // The averaging step is the most commonly dropped part of NOAA's procedure.
    // `simple` alone gives 79.58 here; the correct screening value is their mean.
    expect(computeHeatIndexF(80, 40)).toBeCloseTo(79.79, 2);
  });

  it('applies the low-humidity adjustment', () => {
    // RH < 13 and 80 ≤ T ≤ 112 → subtract. Without it this reads 79.59.
    expect(computeHeatIndexF(82, 10)).toBeCloseTo(79.227, 2);
  });

  it('applies the high-humidity adjustment', () => {
    // RH > 85 and 80 ≤ T ≤ 87 → add.
    expect(computeHeatIndexF(86, 90)).toBeCloseTo(105.394, 2);
  });

  it('subtracts exactly 2°F at the peak of the low-humidity correction', () => {
    // At T=95 the square root term is sqrt(17/17)=1, so the adjustment reduces to
    // (13−RH)/4 — a clean closed form worth pinning.
    expect(computeHeatIndexF(95, 5)).toBeCloseTo(rothfuszHeatIndexF(95, 5) - 2, 10);
  });

  it('adds exactly 0.4°F at 85°F / 95% humidity', () => {
    // ((95−85)/10) * ((87−85)/5) = 1 * 0.4.
    expect(computeHeatIndexF(85, 95)).toBeCloseTo(rothfuszHeatIndexF(85, 95) + 0.4, 10);
  });

  it('self-cancels each adjustment to zero at the top of its temperature range', () => {
    // T=112 zeroes the low-humidity square root; T=87 zeroes the high-humidity
    // factor. Both must then equal the *unadjusted* regression bit-for-bit — an
    // off-by-one in either range bound would show up as a discontinuity here.
    expect(computeHeatIndexF(112, 5)).toBe(rothfuszHeatIndexF(112, 5));
    expect(computeHeatIndexF(87, 95)).toBe(rothfuszHeatIndexF(87, 95));
  });

  it('applies no adjustment just outside each temperature range', () => {
    expect(computeHeatIndexF(113, 5)).toBe(rothfuszHeatIndexF(113, 5));
    expect(computeHeatIndexF(88, 95)).toBe(rothfuszHeatIndexF(88, 95));
  });

  it('still applies the adjustment just inside each range', () => {
    // Guards against a range bound written as `<` where NOAA specifies `<=`, which
    // would silently drop the correction for a sliver of real conditions.
    expect(computeHeatIndexF(111.9, 5)).toBeLessThan(rothfuszHeatIndexF(111.9, 5));
    expect(computeHeatIndexF(86.9, 95)).toBeGreaterThan(rothfuszHeatIndexF(86.9, 95));
  });

  it('treats the humidity bounds as strict, so neither adjustment fires at 13% or 85%', () => {
    // NOAA specifies RH < 13 and RH > 85. Written inclusively, both boundaries would
    // pick up a zero-magnitude adjustment — harmless here, but the same slip on the
    // temperature bounds is not, so the convention is pinned.
    expect(computeHeatIndexF(85, 13)).toBe(rothfuszHeatIndexF(85, 13));
    expect(computeHeatIndexF(85, 85)).toBe(rothfuszHeatIndexF(85, 85));
  });

  it('never applies both adjustments, since humidity cannot be below 13 and above 85', () => {
    // Structural, but a refactor from else-if to a second if would break it, and the
    // result would merely be a slightly wrong number — nothing would throw.
    for (const humidity of [0, 12.9, 13, 85, 85.1, 100]) {
      const value = computeHeatIndexF(85, humidity) as number;
      const unadjusted = rothfuszHeatIndexF(85, humidity);
      const lowMagnitude =
        humidity < 13 ? ((13 - humidity) / 4) * Math.sqrt((17 - Math.abs(85 - 95)) / 17) : 0;
      const highMagnitude = humidity > 85 ? ((humidity - 85) / 10) * ((87 - 85) / 5) : 0;
      expect(value).toBeCloseTo(unadjusted - lowMagnitude + highMagnitude, 10);
    }
  });
});

describe('heat index — input validation fails closed', () => {
  it.each([
    ['NaN temperature', Number.NaN, 50],
    ['NaN humidity', 90, Number.NaN],
    ['Infinite temperature', Number.POSITIVE_INFINITY, 50],
    ['negative humidity', 90, -1],
    ['humidity above 100', 90, 101],
  ])('returns null for %s', (_label, tempF, humidity) => {
    expect(computeHeatIndexF(tempF, humidity)).toBeNull();
  });

  it('cannot detect humidity passed as a fraction, so records the exposure', () => {
    // 0.62 meaning "62 %" is a real and silent unit mistake, but it is *in* range and
    // therefore unrejectable. It reads far too low rather than too high, so it
    // suppresses the flag — the failure direction that matters. Documented here so the
    // limitation is known rather than assumed away; callers own the unit contract.
    expect(computeHeatIndexF(101, 0.62)).not.toBeNull();
    expect(isHeatStressFlaggedF(computeHeatIndexF(101, 0.62) as number)).toBe(false);
    expect(isHeatStressFlaggedF(computeHeatIndexF(101, 62) as number)).toBe(true);
  });

  it('returns null from the Celsius wrapper for unusable input', () => {
    expect(computeHeatIndexC(Number.NaN, 50)).toBeNull();
    expect(computeHeatIndexC(38, 101)).toBeNull();
  });

  it('treats an unusable heat index as Normal rather than silently flagging', () => {
    // NaN >= 103 is false, so a NaN would *disable* the flag. Banding must not depend
    // on that accident.
    expect(heatIndexBandForF(Number.NaN).label).toBe('Normal');
    expect(heatIndexBandForC(Number.NaN).label).toBe('Normal');
    expect(isHeatStressFlaggedF(Number.NaN)).toBe(false);
  });
});

describe('heat index — band boundaries', () => {
  it.each([
    [79.99, 'Normal', 'green'],
    [80, 'Caution', 'green'],
    [89.99, 'Caution', 'green'],
    [90, 'Extreme Caution', 'amber'],
    [102.99, 'Extreme Caution', 'amber'],
    [103, 'Danger', 'red'],
    [124.99, 'Danger', 'red'],
    [125, 'Extreme Danger', 'red'],
    [200, 'Extreme Danger', 'red'],
  ])('%p°F is %s / %s', (heatIndexF, label, level) => {
    const band = heatIndexBandForF(heatIndexF);
    expect(band.label).toBe(label);
    expect(band.level).toBe(level);
  });

  it('places the flag threshold exactly at the Danger floor', () => {
    expect(HEAT_STRESS_FLAG_MIN_F).toBe(HEAT_INDEX_BAND_MIN_F.danger);
    expect(HEAT_STRESS_FLAG_MIN_F).toBe(103);
  });

  it('flags at the boundary inclusively and not below it', () => {
    expect(isHeatStressFlaggedF(103)).toBe(true);
    expect(isHeatStressFlaggedF(102.999)).toBe(false);
  });

  it('starts red exactly where the flag fires, so red always means a rule fired', () => {
    // The mock data originally had Danger → amber. If that mapping came back, a red
    // card and a fired flag would no longer coincide.
    expect(heatIndexBandForF(HEAT_STRESS_FLAG_MIN_F).level).toBe('red');
    expect(heatIndexBandForF(HEAT_STRESS_FLAG_MIN_F - 0.01).level).not.toBe('red');
  });
});

describe('heat index — unit conversion', () => {
  it('round-trips the integer band floors exactly', () => {
    // Not a given in binary floating point, and the whole banding strategy leans on
    // it: if 103°F → °C → °F landed at 102.99999999999999, a Celsius-sourced value at
    // the boundary would silently fail to flag. Asserted rather than assumed.
    for (const floorF of Object.values(HEAT_INDEX_BAND_MIN_F)) {
      expect(celsiusToFahrenheit(fahrenheitToCelsius(floorF))).toBe(floorF);
      expect(heatIndexBandForC(fahrenheitToCelsius(floorF)).level).toBe(
        heatIndexBandForF(floorF).level,
      );
    }
  });

  it('agrees between the Fahrenheit and Celsius entry points', () => {
    const tempC = 38;
    const humidity = 62;
    const viaF = computeHeatIndexF(celsiusToFahrenheit(tempC), humidity) as number;
    expect(computeHeatIndexC(tempC, humidity)).toBeCloseTo(fahrenheitToCelsius(viaF), 10);
  });

  it('rejects Celsius fed in as if it were Fahrenheit', () => {
    // The failure this guards is silent, not loud: 38 °C read as 38 °F produces a
    // plausible number rather than an error, so only a value assertion catches it.
    const wrong = computeHeatIndexF(38, 62) as number;
    const right = computeHeatIndexF(celsiusToFahrenheit(38), 62) as number;
    expect(wrong).toBeLessThan(right);
    expect(heatIndexBandForF(wrong).label).toBe('Normal');
    expect(heatIndexBandForF(right).label).toBe('Extreme Danger');
  });
});

describe('heat index — validated domain', () => {
  it('marks dry-bulb temperatures above the chart as out of domain', () => {
    expect(isHeatIndexOutOfDomain(HEAT_INDEX_MAX_VALID_TEMP_F)).toBe(false);
    expect(isHeatIndexOutOfDomain(HEAT_INDEX_MAX_VALID_TEMP_F + 0.01)).toBe(true);
    expect(isHeatIndexOutOfDomain(Number.NaN)).toBe(false);
  });

  it('keeps warning above the domain rather than going quiet', () => {
    // 45 °C (113 °F) is past the chart. The figure is meaningless, but failing safe
    // means it must still band as dangerous rather than be discarded.
    const tempF = celsiusToFahrenheit(45);
    expect(isHeatIndexOutOfDomain(tempF)).toBe(true);
    expect(isHeatStressFlaggedF(computeHeatIndexF(tempF, 70) as number)).toBe(true);
  });

  it('diverges inside the domain, so the guard is not a divergence check', () => {
    // 41 °C at 70 % RH returns ~170 °F — physically impossible — while testing as
    // in-domain. Asserted so nobody mistakes `isHeatIndexOutOfDomain` for a sanity
    // check on the output; it only bounds the input against the published chart.
    const tempF = celsiusToFahrenheit(41);
    expect(isHeatIndexOutOfDomain(tempF)).toBe(false);
    expect(computeHeatIndexF(tempF, 70) as number).toBeGreaterThan(160);
  });
});
