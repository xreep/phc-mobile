/**
 * Shapes for the live environment feed (PRD §7.2.3).
 *
 * ## Nullability is the design, not an oversight
 * Every derived field here is `| null`. This module talks to two network APIs over a
 * mobile connection, so partial data is the normal case, not the exception — and the
 * project's standing adapter rule is that a missing input stays absent and is **never**
 * substituted with `0`. That rule exists because the risk engine reads `spo2: 0` as
 * catastrophic hypoxia; the same trap is here in milder form, where `aqi: 0` would assert
 * pristine air and `heatIndexC: 0` would assert freezing conditions. The engine treats
 * `undefined` as "unknown" and declines to amplify, which is the correct behaviour for
 * data we do not have, so nulls are carried honestly all the way to the screen and
 * rendered as an em dash.
 *
 * `tempC` and `humidity` are the exception: they are non-null because a weather response
 * without them is not a weather response, and the parser rejects it rather than
 * manufacturing a `LiveEnvironment` around a hole.
 */

import type { RiskLevel } from '@/constants/health-data';
import type { AqiBasis, AqiCategory, Pollutants } from '@/environment/aqi';
import type { HeatIndexBand } from '@/risk';

export type Coordinates = {
  readonly latitude: number;
  readonly longitude: number;
};

/**
 * Where the coordinates came from.
 *
 * Surfaced rather than hidden: a reading for the fallback city is not a reading for where
 * the user is standing, and a health app that quietly shows another city's heat warning as
 * if it were local is worse than one that admits it does not know.
 */
export type LocationSource =
  /** Device GPS/network fix at coarse accuracy. */
  | 'device'
  /** Permission denied, unavailable, or timed out — the configured default city. */
  | 'fallback';

export type ResolvedLocation = {
  readonly coordinates: Coordinates;
  readonly source: LocationSource;
  /** Set when `source` is `'fallback'`, so the UI can say *why* it is not using the device. */
  readonly reason?: LocationFallbackReason;
};

export type LocationFallbackReason =
  | 'permission_denied'
  | 'services_disabled'
  | 'unavailable'
  | 'timeout';

/**
 * A derived, human-readable warning.
 *
 * `source` is the *actual* provenance of the derivation — "NOAA heat index" or
 * "US EPA AQI (estimated)" — never a government agency the app has not contacted. The
 * mock this replaces carried advisories labelled "IMD" and "CPCB"; reproducing those
 * labels over OpenWeatherMap data would attribute a warning to an agency that never
 * issued it, which for a heat-wave advisory in India is a meaningful misrepresentation
 * rather than a cosmetic one. Integrating IMD or CPCB properly is separate work.
 */
export type EnvironmentAdvisory = {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly detail: string;
  readonly level: RiskLevel;
};

/** One resolved observation of the user's surroundings. */
export type LiveEnvironment = {
  /** Provider's place name, or a coordinate string when it does not supply one. */
  readonly location: string;
  readonly coordinates: Coordinates;
  readonly locationSource: LocationSource;
  readonly locationFallbackReason?: LocationFallbackReason;

  /** Provider's observation time (`dt`), epoch ms — what "updated N min ago" means. */
  readonly observedAt: number;
  /** When this device received it, epoch ms. Diverges from `observedAt` when served from cache. */
  readonly fetchedAt: number;

  readonly tempC: number;
  readonly humidity: number;

  /** NOAA Rothfusz, derived from `tempC`/`humidity`; null when the inputs are unusable. */
  readonly heatIndexC: number | null;
  readonly heatIndexBand: HeatIndexBand | null;

  /** US EPA 0–500, estimated from pollutant concentrations. Never OWM's raw 1–5 band. */
  readonly aqi: number | null;
  readonly aqiCategory: AqiCategory | null;
  readonly aqiBasis: AqiBasis | null;
  readonly pollutants: Pollutants | null;

  readonly advisories: readonly EnvironmentAdvisory[];
};

/** What the last fetch attempt did, so the screen can be honest about what it is showing. */
export type EnvironmentStatus =
  /** No data yet and a request in flight. */
  | 'loading'
  /** Fresh data from the network. */
  | 'live'
  /** Network failed; showing the last successful response from disk. */
  | 'cached'
  /** Network failed and there is nothing cached. */
  | 'error';

export type EnvironmentFailure = {
  /** Safe to show a user: no key, no coordinates, no URLs. */
  readonly message: string;
  readonly kind: 'network' | 'auth' | 'rate_limit' | 'config' | 'response' | 'unknown';
};
