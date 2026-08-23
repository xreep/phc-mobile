/**
 * NOAA/NWS heat index (PRD §7.2.2, Tier 1 heat-stress rule).
 *
 * Pure arithmetic — no React, no react-native, no Expo, no clock, no I/O — so it
 * is unit-testable in isolation and reusable by the environmental-context module
 * (PRD §7.2.3) and the Environment screen without pulling in the rest of the engine.
 *
 * ## Provenance
 * Rothfusz regression and both humidity adjustments per NOAA/NWS Weather Prediction
 * Center (`wpc.ncep.noaa.gov/html/heatindex_equation.shtml`), originally Lans P.
 * Rothfusz, NWS Technical Attachment SR 90-23 (1990), itself a fit to Steadman
 * (1979). The four bands are NOAA/NWS (`weather.gov/ama/heatindex`).
 *
 * There is **no WHO heat index formula** — WHO heat-health guidance is qualitative
 * and defers to locally defined thresholds. Despite PRD §7.2.2's "NOAA/WHO" phrasing,
 * this is a NOAA/NWS index and the bands must not be described as WHO's.
 *
 * ## Two invariants that cause silent, dangerous failures if broken
 * 1. **The regression is defined only in Fahrenheit, with humidity as 0–100.**
 *    Convert °C→°F, run everything (screening and adjustments included) in °F, and
 *    convert only the final result back to °C. Feeding Celsius in raw does not throw:
 *    for 38 °C / 62 % it returns 137.79, a plausible-looking Fahrenheit number.
 * 2. **Classify bands in Fahrenheit against the integers 80/90/103/125.** The
 *    Celsius equivalents are repeating decimals (103 °F = 39.444…°C). Rounding them
 *    to 39/41/52/54 and comparing in Celsius *under-warns* — e.g. a real 104 °F
 *    ("Danger") reads as 40 °C and would fall below a rounded 41 °C threshold.
 */

import type { RiskLevel } from '@/constants/health-data';

/** Ordered severity labels. `'Normal'` is ours, for "below NOAA's lowest band". */
export type HeatIndexBandLabel =
  | 'Normal'
  | 'Caution'
  | 'Extreme Caution'
  | 'Danger'
  | 'Extreme Danger';

/**
 * Structurally `{ label: string; level: RiskLevel }`, which is what
 * `LiveEnvironment['heatIndexBand']` holds, so `src/app/environment.tsx` renders it through
 * its `LevelChip` with no mapping layer.
 */
export type HeatIndexBand = {
  readonly label: HeatIndexBandLabel;
  readonly level: RiskLevel;
};

/**
 * NOAA band floors in °F. Lower-inclusive, upper-exclusive: Caution [80,90),
 * Extreme Caution [90,103), Danger [103,125), Extreme Danger [125,∞).
 *
 * NWS prints Danger as "103–124" only because the chart is integer-valued; a
 * continuous implementation must place 124.5 somewhere, and Danger is its home.
 * Do not "correct" the Extreme Danger floor to 126.
 */
export const HEAT_INDEX_BAND_MIN_F = {
  caution: 80,
  extremeCaution: 90,
  danger: 103,
  extremeDanger: 125,
} as const;

/**
 * The heat-stress flag fires at Danger or above (PRD §7.2.2: "crossing 'Danger'/
 * 'Extreme Danger' bands"). Inclusive at 103 °F — NWS calls a heat index
 * "meeting or exceeding 103°F" hazardous.
 */
export const HEAT_STRESS_FLAG_MIN_F = HEAT_INDEX_BAND_MIN_F.danger;

/**
 * Above this dry-bulb temperature we are outside the range the published NWS chart
 * covers (it tops out at 110 °F), so the computed figure must not be shown as an
 * interpretable "feels like" temperature. See {@link isHeatIndexOutOfDomain}.
 *
 * This is a **presentation guard, not a divergence check**, and the difference matters:
 * the regression already runs away *inside* the domain. 41 °C (105.8 °F) at 70 % RH
 * yields a physically absurd 170 °F yet tests as in-domain. Divergence is upward, so
 * the heat-stress flag still fires and the safety direction is right — only the number
 * is untrustworthy. Catching divergence itself would require bounding the *output*,
 * which is a separate decision and not what this constant does.
 */
export const HEAT_INDEX_MAX_VALID_TEMP_F = 110;

/** Level mapping. Red begins exactly where PRD §7.2.2's flag fires, so a red heat
 *  card always means a documented rule fired — never merely "getting warm". */
const BAND_LEVELS: Readonly<Record<HeatIndexBandLabel, RiskLevel>> = {
  Normal: 'green',
  Caution: 'green',
  'Extreme Caution': 'amber',
  Danger: 'red',
  'Extreme Danger': 'red',
};

/** Ordered floors, ascending, for legends and charts. */
export const HEAT_INDEX_BANDS: readonly {
  readonly label: HeatIndexBandLabel;
  readonly level: RiskLevel;
  readonly minF: number;
  readonly minC: number;
}[] = [
  { label: 'Normal', level: 'green', minF: Number.NEGATIVE_INFINITY, minC: Number.NEGATIVE_INFINITY },
  { label: 'Caution', level: 'green', minF: 80, minC: fahrenheitToCelsius(80) },
  { label: 'Extreme Caution', level: 'amber', minF: 90, minC: fahrenheitToCelsius(90) },
  { label: 'Danger', level: 'red', minF: 103, minC: fahrenheitToCelsius(103) },
  { label: 'Extreme Danger', level: 'red', minF: 125, minC: fahrenheitToCelsius(125) },
];

export function celsiusToFahrenheit(tempC: number): number {
  return (tempC * 9) / 5 + 32;
}

export function fahrenheitToCelsius(tempF: number): number {
  return ((tempF - 32) * 5) / 9;
}

/** True when either input is absent or non-finite. NaN propagates silently through
 *  every term and `NaN >= 103` is `false`, which would quietly *disable* the
 *  safety flag — so callers must fail closed rather than treat NaN as "fine". */
function isUnusable(value: number | undefined | null): value is undefined {
  return value === undefined || value === null || !Number.isFinite(value);
}

/**
 * Rothfusz regression. °F in, °F out. Exported only for tests that need to pin
 * individual coefficients; production callers want {@link computeHeatIndexF}.
 */
export function rothfuszHeatIndexF(tempF: number, humidity: number): number {
  const t = tempF;
  const r = humidity;
  const t2 = t * t;
  const r2 = r * r;

  return (
    -42.379 +
    2.04901523 * t +
    10.14333127 * r -
    0.22475541 * t * r -
    0.00683783 * t2 -
    0.05481717 * r2 +
    0.00122874 * t2 * r +
    0.00085282 * t * r2 -
    0.00000199 * t2 * r2
  );
}

/**
 * Heat index in °F, or `null` if the inputs are unusable.
 *
 * NOAA's procedure, in order:
 *  1. `simple = 0.5 * (T + 61 + (T-68)*1.2 + RH*0.094)`
 *  2. `screen = (simple + T) / 2`  ← the averaging step, the most commonly dropped
 *     part of the algorithm. The screening value is the *mean* of `simple` and the
 *     dry-bulb temperature, not `simple` itself.
 *  3. `screen >= 80` → Rothfusz plus at most one humidity adjustment.
 *     `screen < 80`  → return `screen`. Rothfusz is explicitly inappropriate here.
 *
 * NOAA's prose is ambiguous about whether the sub-80 return is `simple` or `screen`;
 * `screen` reproduces the published chart more closely (80 °F/40 % → 79.79 vs the
 * chart's 80, where `simple` gives 79.58), so `screen` is what we return. The
 * distinction is immaterial to safety — it lives entirely below the Caution band,
 * where no flag fires and the value is not a validated apparent temperature anyway.
 *
 * `humidity` is a **percentage (0–100)**, not a fraction. Passing 0.62 for 62 %
 * yields a nonsense low value that silently clears the flag, so it is rejected.
 */
export function computeHeatIndexF(tempF: number, humidity: number): number | null {
  if (isUnusable(tempF) || isUnusable(humidity)) return null;
  // Reject fractions-mistaken-for-percentages and physically impossible humidity.
  if (humidity < 0 || humidity > 100) return null;

  const simple = 0.5 * (tempF + 61.0 + (tempF - 68.0) * 1.2 + humidity * 0.094);
  const screen = (simple + tempF) / 2;
  if (screen < 80) return screen;

  let heatIndex = rothfuszHeatIndexF(tempF, humidity);

  // The two adjustments are mutually exclusive (RH cannot be both < 13 and > 85),
  // use strict inequalities on RH and inclusive temperature ranges, and are never
  // applied to the simple-formula result. Each self-cancels to exactly 0 at the top
  // of its range (T=112 zeroes the sqrt; T=87 zeroes the second factor).
  if (humidity < 13 && tempF >= 80 && tempF <= 112) {
    heatIndex -= ((13 - humidity) / 4) * Math.sqrt((17 - Math.abs(tempF - 95)) / 17);
  } else if (humidity > 85 && tempF >= 80 && tempF <= 87) {
    heatIndex += ((humidity - 85) / 10) * ((87 - tempF) / 5);
  }

  return heatIndex;
}

/**
 * Heat index in °C, or `null` if the inputs are unusable.
 *
 * Named `computeHeatIndexC` rather than `heatIndexC` because `heatIndexC` is a
 * *property* name on `EnvironmentData`/`EnvironmentSnapshot` and would read as a
 * field at destructuring sites.
 */
export function computeHeatIndexC(tempC: number, humidity: number): number | null {
  if (isUnusable(tempC)) return null;
  const heatIndexF = computeHeatIndexF(celsiusToFahrenheit(tempC), humidity);
  return heatIndexF === null ? null : fahrenheitToCelsius(heatIndexF);
}

/** Classify a °F heat index. Always classify the *unrounded* value: rounding first
 *  can push 102.996 up to 103.0 and flag it. */
export function heatIndexBandForF(heatIndexF: number): HeatIndexBand {
  const label: HeatIndexBandLabel = isUnusable(heatIndexF)
    ? 'Normal'
    : heatIndexF >= HEAT_INDEX_BAND_MIN_F.extremeDanger
      ? 'Extreme Danger'
      : heatIndexF >= HEAT_INDEX_BAND_MIN_F.danger
        ? 'Danger'
        : heatIndexF >= HEAT_INDEX_BAND_MIN_F.extremeCaution
          ? 'Extreme Caution'
          : heatIndexF >= HEAT_INDEX_BAND_MIN_F.caution
            ? 'Caution'
            : 'Normal';

  return { label, level: BAND_LEVELS[label] };
}

/** Classify a °C heat index by converting to °F first — see the file header on why
 *  Celsius thresholds must never be rounded and compared directly. */
export function heatIndexBandForC(heatIndexC: number): HeatIndexBand {
  if (isUnusable(heatIndexC)) return { label: 'Normal', level: BAND_LEVELS.Normal };
  return heatIndexBandForF(celsiusToFahrenheit(heatIndexC));
}

/** True when the heat-stress flag of PRD §7.2.2 fires (Danger or Extreme Danger). */
export function isHeatStressFlaggedF(heatIndexF: number): boolean {
  return Number.isFinite(heatIndexF) && heatIndexF >= HEAT_STRESS_FLAG_MIN_F;
}

/**
 * True when the dry-bulb temperature is outside the regression's validated domain,
 * where the reported number becomes physically meaningless (it diverges upward).
 *
 * Callers should keep warning — saturated at Extreme Danger, which is fail-safe —
 * but should not present the raw figure as a temperature a person can interpret.
 */
export function isHeatIndexOutOfDomain(tempF: number): boolean {
  return Number.isFinite(tempF) && tempF > HEAT_INDEX_MAX_VALID_TEMP_F;
}
