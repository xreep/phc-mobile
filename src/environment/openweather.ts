/**
 * OpenWeatherMap clients: Current Weather and Air Pollution (PRD §7.2.3).
 *
 * ## Why OpenWeatherMap for AQI
 * PRD §7.2.3 names CPCB as the air-quality source. CPCB's API requires a separate
 * government registration with its own approval cycle, so this uses OpenWeatherMap's Air
 * Pollution API — same key, same call pattern, available now. The tradeoff is recorded
 * where it matters: `aqi.ts` estimates a US EPA index from OWM's pollutant
 * concentrations, and the advisory text says "estimated" rather than claiming a CPCB
 * figure. Swapping in CPCB later means replacing `fetchAirQuality` and nothing else.
 *
 * ## The key
 * Read from `EXPO_PUBLIC_OPENWEATHER_API_KEY` via a **literal** `process.env` member
 * expression. That is not stylistic: Expo's Babel transform inlines `EXPO_PUBLIC_*`
 * variables at build time by matching the static property access, so a dynamic
 * `process.env[name]` would compile to a lookup on an empty object and the key would be
 * silently absent in a release bundle.
 *
 * Being an `EXPO_PUBLIC_` variable, this key ships inside the client bundle and is
 * extractable from any installed copy of the app — that is inherent to how Expo exposes
 * it, and acceptable for a rate-limited read-only weather key. It is emphatically **not**
 * acceptable for the SOS phase's Twilio credentials, which need a server-side proxy.
 *
 * ## Failure handling
 * Errors carry a status-derived message and never the request URL, because the URL
 * contains `appid`. An error string with the key in it would leak into logs, crash
 * reporters, and the odd screenshot.
 */

import type { Pollutants } from '@/environment/aqi';
import type { Coordinates, EnvironmentFailure } from '@/environment/types';

const WEATHER_URL = 'https://api.openweathermap.org/data/2.5/weather';
const AIR_POLLUTION_URL = 'https://api.openweathermap.org/data/2.5/air_pollution';

/** Long enough for a slow mobile connection, short enough not to hang a pull-to-refresh. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** An expected, user-presentable failure. Thrown instead of letting a raw fetch error escape. */
export class EnvironmentError extends Error {
  readonly kind: EnvironmentFailure['kind'];

  constructor(message: string, kind: EnvironmentFailure['kind']) {
    super(message);
    this.name = 'EnvironmentError';
    this.kind = kind;
  }
}

/**
 * The configured API key, or null.
 *
 * Written as a literal member expression so Expo's build-time inlining applies. Trimmed
 * because a trailing newline in `.env.local` is easy to introduce and produces a
 * bewildering 401 rather than an obvious mistake.
 */
export function readApiKey(): string | null {
  const key = process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY;
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type FetchOptions = {
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to the global. */
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
};

function messageForStatus(status: number): EnvironmentError {
  if (status === 401) {
    return new EnvironmentError(
      'Weather service rejected the API key. Check EXPO_PUBLIC_OPENWEATHER_API_KEY.',
      'auth',
    );
  }
  if (status === 429) {
    return new EnvironmentError(
      'Weather service call limit reached. Try again in a few minutes.',
      'rate_limit',
    );
  }
  if (status >= 500) {
    return new EnvironmentError('Weather service is temporarily unavailable.', 'network');
  }
  return new EnvironmentError(`Weather service returned an error (${status}).`, 'response');
}

async function fetchJson(
  baseUrl: string,
  params: Readonly<Record<string, string>>,
  options: FetchOptions,
): Promise<unknown> {
  const apiKey = readApiKey();
  if (apiKey === null) {
    throw new EnvironmentError(
      'No weather API key configured. Set EXPO_PUBLIC_OPENWEATHER_API_KEY in .env.local.',
      'config',
    );
  }

  const query = new URLSearchParams({ ...params, appid: apiKey });
  const url = `${baseUrl}?${query.toString()}`;

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // A caller-supplied signal (screen unmounted, newer refresh started) has to compose
  // with the timeout rather than replace it.
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  try {
    const response = await doFetch(url, { signal: controller.signal });
    if (!response.ok) throw messageForStatus(response.status);
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof EnvironmentError) throw error;
    // Deliberately does not interpolate the original message: a fetch failure can echo
    // the request URL, and the URL carries the key.
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new EnvironmentError(
      aborted ? 'Weather request timed out.' : 'Could not reach the weather service.',
      'network',
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * OWM timestamps (`dt`) are epoch **seconds**; everything in this app is epoch ms.
 *
 * Getting this wrong is not a subtle off-by-a-constant — a seconds value read as ms lands
 * in January 1970, so every freshness check sees an observation 56 years stale and the
 * engine reports the environment unusable. Returns null rather than a guess when absent.
 */
function epochSecondsToMs(value: unknown): number | null {
  const seconds = asFiniteNumber(value);
  return seconds === null ? null : Math.round(seconds * 1000);
}

export type WeatherObservation = {
  readonly tempC: number;
  readonly humidity: number;
  /** Provider's place name, absent for some ocean/remote coordinates. */
  readonly location: string | null;
  readonly observedAt: number | null;
};

/**
 * Current temperature and humidity for a coordinate.
 *
 * `units=metric` so `main.temp` arrives in °C — the app's unit throughout, and the unit
 * `computeHeatIndexC` expects. Omitting it would return Kelvin, which is the kind of
 * mistake that produces a plausible-looking 311 °C rather than an error.
 */
export async function fetchWeather(
  coordinates: Coordinates,
  options: FetchOptions = {},
): Promise<WeatherObservation> {
  const payload = await fetchJson(
    WEATHER_URL,
    {
      lat: String(coordinates.latitude),
      lon: String(coordinates.longitude),
      units: 'metric',
    },
    options,
  );

  const root = asRecord(payload);
  const main = asRecord(root?.main);
  const tempC = asFiniteNumber(main?.temp);
  const humidity = asFiniteNumber(main?.humidity);

  if (tempC === null || humidity === null) {
    throw new EnvironmentError('Weather service returned an unexpected response.', 'response');
  }

  const name = typeof root?.name === 'string' && root.name.length > 0 ? root.name : null;

  return { tempC, humidity, location: name, observedAt: epochSecondsToMs(root?.dt) };
}

export type AirQualityObservation = {
  readonly pollutants: Pollutants;
  /** OWM's own 1–5 band. Kept only as the fallback input to `estimateAqi`. */
  readonly owmIndex: number | undefined;
  readonly observedAt: number | null;
};

/**
 * Pollutant concentrations for a coordinate.
 *
 * Returns the raw µg/m³ components rather than an AQI. Converting to the EPA index is
 * `aqi.ts`'s job, kept separate so the conversion is a pure function with its own
 * boundary tests instead of something buried in a network call.
 */
export async function fetchAirQuality(
  coordinates: Coordinates,
  options: FetchOptions = {},
): Promise<AirQualityObservation> {
  const payload = await fetchJson(
    AIR_POLLUTION_URL,
    { lat: String(coordinates.latitude), lon: String(coordinates.longitude) },
    options,
  );

  const root = asRecord(payload);
  const list = Array.isArray(root?.list) ? root.list : null;
  const first = asRecord(list?.[0]);

  if (first === null) {
    throw new EnvironmentError(
      'Air quality service returned no readings for this location.',
      'response',
    );
  }

  const components = asRecord(first.components);
  const pollutants: Pollutants = {};
  const mutable = pollutants as { -readonly [K in keyof Pollutants]: number | undefined };

  // Copied key by key, not spread: `components` is untrusted JSON, and a spread would
  // carry through whatever else it contained, including non-numeric values that would
  // reach the breakpoint lookup as strings.
  for (const key of ['pm2_5', 'pm10', 'o3', 'no2', 'so2', 'co'] as const) {
    const value = asFiniteNumber(components?.[key]);
    if (value !== null) mutable[key] = value;
  }

  const index = asFiniteNumber(asRecord(first.main)?.aqi);

  return {
    pollutants,
    owmIndex: index ?? undefined,
    observedAt: epochSecondsToMs(first.dt),
  };
}
