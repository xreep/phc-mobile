/**
 * Assembles one live environment observation from location + two OpenWeatherMap calls,
 * and adapts it for the risk engine (PRD §7.2.3).
 *
 * ## Weather is required, air quality is not
 * The two calls run concurrently and are settled independently. A failed air-quality call
 * leaves `aqi: null` and still returns a usable observation, because losing the AQI card
 * is a much smaller loss than losing the heat reading — and heat is the flag PRD §7.2.5
 * escalates on. A failed weather call has no such fallback: without temperature and
 * humidity there is no observation, so it propagates and the caller falls back to cache.
 *
 * ## Why the heat index is not sent to the engine
 * `EnvironmentSnapshot.heatIndexC` exists so a provider's own figure can outrank a derived
 * one — `resolveHeatIndex` prefers it when present. OpenWeatherMap does not publish a NOAA
 * heat index (`main.feels_like` is a different model, blending wind chill and humidity),
 * so there is nothing authoritative to forward. Passing our own derived value back in
 * would be laundering a computation into an apparent measurement. Instead the snapshot
 * carries only `tempC`/`humidity` and the engine derives the index with `computeHeatIndexC`
 * — the same function this module uses for display, so the number on the Environment
 * screen and the number driving the heat card cannot disagree.
 */

import { estimateAqi, type AqiEstimate } from '@/environment/aqi';
import { writeCachedEnvironment } from '@/environment/cache';
import { FALLBACK_LOCATION, resolveLocation } from '@/environment/location';
import {
  EnvironmentError,
  fetchAirQuality,
  fetchWeather,
  type FetchOptions,
} from '@/environment/openweather';
import type {
  Coordinates,
  EnvironmentAdvisory,
  LiveEnvironment,
  ResolvedLocation,
} from '@/environment/types';
import {
  computeHeatIndexC,
  heatIndexBandForC,
  type EnvironmentSnapshot,
  type HeatIndexBand,
} from '@/risk';

/**
 * NOAA's published effects for each heat-index band, which is the right provenance for a
 * heat-index advisory — the band boundaries and these descriptions come from the same NWS
 * chart. Only bands worth interrupting the user for appear here; `Normal` and `Caution`
 * produce no advisory, because a card that fires in comfortable weather trains people to
 * ignore the one that fires in dangerous weather.
 */
const HEAT_ADVISORY_DETAIL: Readonly<Record<string, string>> = {
  'Extreme Caution':
    'Heat exhaustion is possible with prolonged exposure or activity. Limit time in direct sun between 12pm and 3pm.',
  Danger:
    'Heat cramps and heat exhaustion are likely, and heat stroke is possible with prolonged exertion. Stay in the shade and drink water regularly.',
  'Extreme Danger':
    'Heat stroke is highly likely with continued exposure. Stay indoors, avoid all exertion, and drink water now.',
};

/** US EPA's own category statements, quoted rather than paraphrased. */
const AQI_ADVISORY_DETAIL: Readonly<Record<string, string>> = {
  'Unhealthy for Sensitive Groups':
    'Members of sensitive groups may experience health effects. People with heart or lung disease, older adults and children should limit prolonged exertion outdoors.',
  Unhealthy:
    'Some members of the general public may experience health effects, and members of sensitive groups may experience more serious effects. Limit time outdoors.',
  'Very Unhealthy':
    'Health alert: the risk of health effects is increased for everyone. Avoid outdoor exertion and keep windows closed.',
  Hazardous:
    'Health warning of emergency conditions: everyone is more likely to be affected. Stay indoors.',
};

/**
 * Every AQI this app produces is an estimate — EPA's PM breakpoints are defined on 24-hour
 * averages and OpenWeatherMap reports current concentrations (see `aqi.ts`). The label says
 * so rather than implying a published CPCB or AirNow figure.
 */
const AQI_SOURCE_LABEL = 'US EPA AQI (estimated)';

function buildAdvisories(
  heatIndexC: number | null,
  heatIndexBand: HeatIndexBand | null,
  aqiEstimate: AqiEstimate | null,
): EnvironmentAdvisory[] {
  const advisories: EnvironmentAdvisory[] = [];

  if (heatIndexBand !== null && heatIndexC !== null) {
    const detail = HEAT_ADVISORY_DETAIL[heatIndexBand.label];
    if (detail !== undefined) {
      advisories.push({
        id: 'heat-index',
        source: 'NOAA heat index',
        title: `${heatIndexBand.label} heat — feels like ${Math.round(heatIndexC)}°C`,
        detail,
        level: heatIndexBand.level,
      });
    }
  }

  if (aqiEstimate !== null) {
    const detail = AQI_ADVISORY_DETAIL[aqiEstimate.category.label];
    if (detail !== undefined) {
      advisories.push({
        id: 'air-quality',
        source: AQI_SOURCE_LABEL,
        title: `${aqiEstimate.category.label} air — AQI ${aqiEstimate.aqi}`,
        detail,
        level: aqiEstimate.category.level,
      });
    }
  }

  return advisories;
}

/** Human-readable coordinates, for the rare place OWM returns no name for. */
function describeCoordinates({ latitude, longitude }: Coordinates): string {
  const ns = latitude >= 0 ? 'N' : 'S';
  const ew = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(2)}°${ns}, ${Math.abs(longitude).toFixed(2)}°${ew}`;
}

export type FetchLiveEnvironmentOptions = FetchOptions & {
  /** Evaluation instant in epoch ms. Injected so the whole pipeline stays testable. */
  readonly now: number;
  /** Passed to `resolveLocation`; false for background refreshes that must not prompt. */
  readonly canPrompt?: boolean;
  /** Pre-resolved location, so a refresh can reuse a fix instead of asking again. */
  readonly location?: ResolvedLocation;
};

/**
 * One full observation: resolve where we are, ask for weather and air quality, derive the
 * heat index and AQI, and write the result to the offline cache.
 *
 * Throws `EnvironmentError` when weather is unavailable. The cache is only written on
 * success, which is what makes it a *last known good* rather than a last-attempt record.
 */
export async function fetchLiveEnvironment(
  options: FetchLiveEnvironmentOptions,
): Promise<LiveEnvironment> {
  const { now, canPrompt, location: preresolved, ...fetchOptions } = options;

  const location = preresolved ?? (await resolveLocation({ canPrompt }));

  // Concurrent, and settled separately so air quality cannot take weather down with it.
  const [weatherResult, airResult] = await Promise.allSettled([
    fetchWeather(location.coordinates, fetchOptions),
    fetchAirQuality(location.coordinates, fetchOptions),
  ]);

  if (weatherResult.status === 'rejected') {
    throw weatherResult.reason instanceof EnvironmentError
      ? weatherResult.reason
      : new EnvironmentError('Could not reach the weather service.', 'network');
  }

  const weather = weatherResult.value;
  const air = airResult.status === 'fulfilled' ? airResult.value : null;

  const heatIndexC = computeHeatIndexC(weather.tempC, weather.humidity);
  const heatIndexBand = heatIndexC === null ? null : heatIndexBandForC(heatIndexC);
  const aqiEstimate = air === null ? null : estimateAqi(air.pollutants, air.owmIndex);

  const environment: LiveEnvironment = {
    location:
      weather.location ??
      (location.source === 'fallback'
        ? FALLBACK_LOCATION.name
        : describeCoordinates(location.coordinates)),
    coordinates: location.coordinates,
    locationSource: location.source,
    ...(location.reason === undefined ? {} : { locationFallbackReason: location.reason }),

    // `dt` when the provider supplies it; otherwise the moment of the call, which is the
    // closest honest answer rather than 1970.
    observedAt: weather.observedAt ?? now,
    fetchedAt: now,

    tempC: weather.tempC,
    humidity: weather.humidity,
    heatIndexC,
    heatIndexBand,

    aqi: aqiEstimate?.aqi ?? null,
    aqiCategory: aqiEstimate?.category ?? null,
    aqiBasis: aqiEstimate?.basis ?? null,
    pollutants: air?.pollutants ?? null,

    advisories: buildAdvisories(heatIndexC, heatIndexBand, aqiEstimate),
  };

  await writeCachedEnvironment(environment);
  return environment;
}

/**
 * Narrow a `LiveEnvironment` to what the risk engine consumes.
 *
 * Built field by field rather than spread, and this is the boundary that keeps it honest:
 * the engine must not see `location`, the pre-banded labels, or the advisories — those are
 * presentation, and a rule that read them would be keying off a string this module chose
 * rather than off a measurement.
 *
 * `heatIndexC` is deliberately not forwarded (see the file header). `aqi` is omitted rather
 * than sent as `0` when unknown, because the engine reads a missing AQI as "do not amplify"
 * and a zero as "pristine air" — the standing adapter rule in this project, and the one
 * whose violation would turn unknown air into an active reassurance.
 */
export function toEnvironmentSnapshot(environment: LiveEnvironment): EnvironmentSnapshot {
  return {
    tempC: environment.tempC,
    humidity: environment.humidity,
    ...(environment.aqi === null ? {} : { aqi: environment.aqi }),
    observedAt: environment.observedAt,
  };
}
