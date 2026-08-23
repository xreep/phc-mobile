/**
 * US EPA Air Quality Index from pollutant concentrations (PRD §7.2.3).
 *
 * ## Why this file has to exist
 * OpenWeatherMap's Air Pollution API reports `list[].main.aqi` as a **1–5 band index**,
 * not an AQI. The risk engine's thresholds are `aqiNeutralBelow: 100` and
 * `aqiSevereAbove: 300`, documented in `src/risk/config.ts` against the CPCB / US EPA
 * 0–500 scale. Feeding OWM's 1–5 straight through would therefore make `aqi <= 100`
 * permanently true, and the respiratory rule's air-quality amplification would sit at
 * exactly 1.0 forever — no error, no failing test, just an entire PRD input silently
 * doing nothing. That is the same failure shape as the four threshold bugs already fixed
 * in this engine, so the conversion happens here, once, with its own tests.
 *
 * The API does return raw `components` in µg/m³, which is what the EPA breakpoints are
 * defined on, so a real AQI is recoverable rather than guessed.
 *
 * ## The approximation, stated plainly
 * EPA's PM breakpoints are defined on **24-hour averages**. OWM reports *current*
 * concentrations. Applying 24-hour breakpoints to an instantaneous reading is an
 * approximation — EPA itself uses a weighted surrogate ("NowCast") for exactly this
 * reason. Most consumer air-quality apps do what this file does, and it is the best
 * available from a single current-conditions call, but the number is an estimate of the
 * AQI rather than the reported AQI. Hence `estimateAqi`, not `computeAqi`.
 *
 * ## Provenance of the numbers
 * PM2.5 breakpoints are the **2024 revision** (EPA, Final Reconsideration of the PM
 * NAAQS, 7 Feb 2024): the "Good" band tops out at 9.0 µg/m³, not the older 12.0, and
 * "Unhealthy" was widened to 55.5–125.4. Category names and index ranges match
 * airnow.gov's published table. `aqi.test.ts` pins every breakpoint boundary, so if one
 * of these numbers is wrong the test says what was intended rather than leaving it to be
 * inferred from the code.
 */

import type { RiskLevel } from '@/constants/health-data';

export type AqiCategoryLabel =
  | 'Good'
  | 'Moderate'
  | 'Unhealthy for Sensitive Groups'
  | 'Unhealthy'
  | 'Very Unhealthy'
  | 'Hazardous';

export type AqiCategory = {
  readonly label: AqiCategoryLabel;
  readonly level: RiskLevel;
};

/**
 * Which input produced the AQI, so the UI can say how solid the number is and a reader
 * can tell a pollutant-derived value from the coarse band fallback.
 */
export type AqiBasis = 'pm2_5' | 'pm10' | 'owm_index';

export type AqiEstimate = {
  readonly aqi: number;
  readonly category: AqiCategory;
  readonly basis: AqiBasis;
};

/**
 * Traffic-light mapping, aligned to the engine rather than chosen by eye.
 *
 * Green covers Good and Moderate because `aqiNeutralBelow: 100` is the point below which
 * the engine applies no amplification at all — the card and the rule agree on where
 * "unremarkable" ends. Amber is Unhealthy for Sensitive Groups, the first band EPA
 * attaches a cautionary statement to. Red from Unhealthy up.
 */
const CATEGORY_LEVELS: Readonly<Record<AqiCategoryLabel, RiskLevel>> = {
  Good: 'green',
  Moderate: 'green',
  'Unhealthy for Sensitive Groups': 'amber',
  Unhealthy: 'red',
  'Very Unhealthy': 'red',
  Hazardous: 'red',
};

/** AQI index bands. Upper bound inclusive; `Hazardous` absorbs everything above 300. */
const INDEX_BANDS: readonly { readonly max: number; readonly label: AqiCategoryLabel }[] = [
  { max: 50, label: 'Good' },
  { max: 100, label: 'Moderate' },
  { max: 150, label: 'Unhealthy for Sensitive Groups' },
  { max: 200, label: 'Unhealthy' },
  { max: 300, label: 'Very Unhealthy' },
  { max: Infinity, label: 'Hazardous' },
];

export function aqiCategoryFor(aqi: number): AqiCategory {
  const band = INDEX_BANDS.find((candidate) => aqi <= candidate.max) ?? INDEX_BANDS[5];
  return { label: band.label, level: CATEGORY_LEVELS[band.label] };
}

/**
 * One row of the EPA lookup: concentration range → index range, interpolated linearly.
 */
type Breakpoint = {
  readonly cLow: number;
  readonly cHigh: number;
  readonly iLow: number;
  readonly iHigh: number;
};

/** PM2.5, 24-hour, µg/m³ — 2024 revision. */
const PM25_BREAKPOINTS: readonly Breakpoint[] = [
  { cLow: 0.0, cHigh: 9.0, iLow: 0, iHigh: 50 },
  { cLow: 9.1, cHigh: 35.4, iLow: 51, iHigh: 100 },
  { cLow: 35.5, cHigh: 55.4, iLow: 101, iHigh: 150 },
  { cLow: 55.5, cHigh: 125.4, iLow: 151, iHigh: 200 },
  { cLow: 125.5, cHigh: 225.4, iLow: 201, iHigh: 300 },
  { cLow: 225.5, cHigh: 325.4, iLow: 301, iHigh: 500 },
];

/** PM10, 24-hour, µg/m³. */
const PM10_BREAKPOINTS: readonly Breakpoint[] = [
  { cLow: 0, cHigh: 54, iLow: 0, iHigh: 50 },
  { cLow: 55, cHigh: 154, iLow: 51, iHigh: 100 },
  { cLow: 155, cHigh: 254, iLow: 101, iHigh: 150 },
  { cLow: 255, cHigh: 354, iLow: 151, iHigh: 200 },
  { cLow: 355, cHigh: 424, iLow: 201, iHigh: 300 },
  { cLow: 425, cHigh: 604, iLow: 301, iHigh: 500 },
];

/** Beyond the top breakpoint the scale simply ends; EPA reports the ceiling. */
const AQI_CEILING = 500;

function isUsable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Truncate to the precision EPA specifies before lookup — PM2.5 to one decimal, PM10 to
 * whole µg/m³.
 *
 * This is not cosmetic. The bands are quoted as 0.0–9.0 then 9.1–35.4, so a raw 9.05
 * belongs to neither; truncating to 9.0 places it in the first. Skipping this step leaves
 * a hairline gap at every boundary that returns `null` for a perfectly valid reading.
 */
function truncate(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor(value * factor) / factor;
}

function indexFor(
  concentration: number,
  breakpoints: readonly Breakpoint[],
  decimals: number,
): number | null {
  if (!isUsable(concentration)) return null;
  const c = truncate(concentration, decimals);

  for (const bp of breakpoints) {
    if (c >= bp.cLow && c <= bp.cHigh) {
      // EPA's equation, then rounded to the nearest whole index as EPA specifies.
      const index =
        ((bp.iHigh - bp.iLow) / (bp.cHigh - bp.cLow)) * (c - bp.cLow) + bp.iLow;
      return Math.round(index);
    }
  }

  // Above the table. Off the top of the published scale, not an error.
  return c > breakpoints[breakpoints.length - 1].cHigh ? AQI_CEILING : null;
}

/** @param microgramsPerM3 PM2.5 concentration in µg/m³, as OWM reports it. */
export function aqiFromPm25(microgramsPerM3: number): number | null {
  return indexFor(microgramsPerM3, PM25_BREAKPOINTS, 1);
}

/** @param microgramsPerM3 PM10 concentration in µg/m³, as OWM reports it. */
export function aqiFromPm10(microgramsPerM3: number): number | null {
  return indexFor(microgramsPerM3, PM10_BREAKPOINTS, 0);
}

/**
 * OWM's own 1–5 band, mapped to a representative point inside the matching EPA band.
 *
 * A deliberately coarse last resort, used only when `components` is absent or unusable.
 * Discarding the band entirely would be worse than approximating it: the engine reads a
 * missing AQI as "no amplification", so throwing away a "Very Poor" signal would leave
 * hazardous air looking unremarkable. The mapped value is flagged `basis: 'owm_index'`
 * so nothing downstream mistakes it for a pollutant-derived figure.
 */
export function aqiFromOwmIndex(index: number): number | null {
  if (!isUsable(index)) return null;
  switch (Math.round(index)) {
    case 1:
      return 25; // Good
    case 2:
      return 75; // Moderate
    case 3:
      return 125; // Unhealthy for Sensitive Groups
    case 4:
      return 175; // Unhealthy
    case 5:
      return 250; // Very Unhealthy
    default:
      return null;
  }
}

/** Pollutant concentrations in µg/m³, as the Air Pollution API reports them. */
export type Pollutants = {
  readonly pm2_5?: number;
  readonly pm10?: number;
  readonly o3?: number;
  readonly no2?: number;
  readonly so2?: number;
  readonly co?: number;
};

/**
 * Overall AQI: the **maximum** of the available sub-indices.
 *
 * That maximum is the definition, not a heuristic — the AQI is the worst of its
 * pollutants, because the health concern is driven by whichever one is highest, and
 * averaging them would let a clean pollutant mask a dangerous one.
 *
 * Only PM2.5 and PM10 are converted. The gaseous sub-indices are defined on ppb/ppm over
 * specific averaging periods (8-hour O₃, 8-hour CO) which a single current-conditions
 * call cannot supply, so deriving them from instantaneous µg/m³ would be a unit error
 * dressed up as a measurement. In practice PM dominates the AQI across India, which is
 * the deployment context PRD §7.2.3 targets.
 *
 * @param owmIndex OWM's 1–5 band, used only if no PM sub-index is available.
 */
export function estimateAqi(
  pollutants: Pollutants | null | undefined,
  owmIndex?: number,
): AqiEstimate | null {
  const candidates: { readonly aqi: number; readonly basis: AqiBasis }[] = [];

  if (pollutants) {
    const pm25 = pollutants.pm2_5 === undefined ? null : aqiFromPm25(pollutants.pm2_5);
    if (pm25 !== null) candidates.push({ aqi: pm25, basis: 'pm2_5' });

    const pm10 = pollutants.pm10 === undefined ? null : aqiFromPm10(pollutants.pm10);
    if (pm10 !== null) candidates.push({ aqi: pm10, basis: 'pm10' });
  }

  if (candidates.length === 0) {
    if (owmIndex === undefined) return null;
    const fallback = aqiFromOwmIndex(owmIndex);
    if (fallback === null) return null;
    return { aqi: fallback, category: aqiCategoryFor(fallback), basis: 'owm_index' };
  }

  const worst = candidates.reduce((a, b) => (b.aqi > a.aqi ? b : a));
  return { aqi: worst.aqi, category: aqiCategoryFor(worst.aqi), basis: worst.basis };
}
