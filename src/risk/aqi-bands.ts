/**
 * US EPA AQI bands, as the respiratory rule needs them (PS 26181 §3b; PRD §7.2.3).
 *
 * ## Why this is not an import from `src/environment/aqi.ts`
 * That file owns the full EPA table — pollutant breakpoints, the 1–5 OWM fallback, the
 * Environment screen's traffic-light colours — and it would be the obvious thing to reuse. It
 * is also framework-free, so importing it would not drag react-native into the engine. What
 * it *would* do is break the guarantee in the header of `./index.ts`: the engine imports
 * exactly four types from the app and nothing else. That guarantee is what makes `src/risk`
 * droppable into a test, a background task, or a future fusion layer without any of the app
 * behind it, and a value import from `src/environment` is the first step to losing it.
 *
 * So the two edges the rule needs are restated here. `aqi-advisory.test.ts` runs both
 * implementations across every band boundary and asserts they agree, which is what stops
 * the copy from drifting — the same discipline `heat-index.test.ts` applies to the fixture
 * that used to hardcode a heat index next to the inputs it was computed from.
 *
 * Only the three bands above the advisory line get a `RuleId`; the bands below it are
 * labelled here so the metric line can name them, not because the rule reacts to them.
 */

/** EPA label for a band. Spelled as airnow.gov publishes them. */
export type AqiBandLabel =
  | 'Good'
  | 'Moderate'
  | 'Unhealthy for Sensitive Groups'
  | 'Unhealthy'
  | 'Very Unhealthy'
  | 'Hazardous';

/**
 * Inclusive upper edge of the two advisory bands that have one. "Hazardous" absorbs
 * everything above `veryUnhealthy`, and the line the advisory starts from is not here — it is
 * `RiskThresholds.env.aqiAdvisoryAbove`, because it is a tuning decision and these are not.
 */
export const AQI_BAND_MAX = {
  unhealthy: 200,
  veryUnhealthy: 300,
} as const;

/** Inclusive upper edges of the bands below the advisory line, for labelling only. */
const LOWER_BAND_MAX = {
  good: 50,
  moderate: 100,
  sensitiveGroups: 150,
} as const;

/** The EPA band label for an AQI. Upper edges are inclusive, matching airnow.gov. */
export function aqiBandLabelFor(aqi: number): AqiBandLabel {
  if (aqi <= LOWER_BAND_MAX.good) return 'Good';
  if (aqi <= LOWER_BAND_MAX.moderate) return 'Moderate';
  if (aqi <= LOWER_BAND_MAX.sensitiveGroups) return 'Unhealthy for Sensitive Groups';
  if (aqi <= AQI_BAND_MAX.unhealthy) return 'Unhealthy';
  if (aqi <= AQI_BAND_MAX.veryUnhealthy) return 'Very Unhealthy';
  return 'Hazardous';
}
