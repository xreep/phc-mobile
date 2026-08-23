/**
 * Public surface of the live environment feed (PRD §7.2.3).
 *
 * Screens import from here rather than reaching into the individual modules, so the
 * internal split — pure AQI maths, network clients, location, cache, orchestration — stays
 * free to change without a hunt through the app for import paths.
 */

export {
  aqiCategoryFor,
  aqiFromOwmIndex,
  aqiFromPm10,
  aqiFromPm25,
  estimateAqi,
  type AqiBasis,
  type AqiCategory,
  type AqiCategoryLabel,
  type AqiEstimate,
  type Pollutants,
} from './aqi';

export {
  CACHE_KEY,
  CACHE_MAX_AGE_MS,
  clearCachedEnvironment,
  readCachedEnvironment,
  writeCachedEnvironment,
} from './cache';

export {
  COORDINATE_DECIMALS,
  FALLBACK_LOCATION,
  resolveLocation,
  roundCoordinates,
  type ResolveLocationOptions,
} from './location';

export {
  EnvironmentError,
  fetchAirQuality,
  fetchWeather,
  readApiKey,
  type AirQualityObservation,
  type FetchOptions,
  type WeatherObservation,
} from './openweather';

export {
  fetchLiveEnvironment,
  toEnvironmentSnapshot,
  type FetchLiveEnvironmentOptions,
} from './service';

export type {
  Coordinates,
  EnvironmentAdvisory,
  EnvironmentFailure,
  EnvironmentStatus,
  LiveEnvironment,
  LocationFallbackReason,
  LocationSource,
  ResolvedLocation,
} from './types';
