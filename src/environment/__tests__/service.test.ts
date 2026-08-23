/**
 * Live-observation assembly tests.
 *
 * ## The scale trap this file exists to guard
 * OpenWeatherMap's `main.aqi` is a 1–5 band. The risk engine's thresholds
 * (`env.aqiNeutralBelow: 100`, `env.aqiSevereAbove: 300`) are on the 0–500 CPCB/EPA scale.
 * Forwarding the provider's number raw type-checks, renders, and looks entirely plausible —
 * and permanently pins the respiratory air-quality multiplier at 1.0, because `4 <= 100` is
 * always true. No throw, no log, no failing test: the environmental amplification PRD §7.2.3
 * asks for would simply never happen. So the assembled `aqi` is asserted to be the computed
 * EPA index and explicitly *not* the provider band.
 *
 * ## Why the heat index is asserted twice
 * The observation carries a `heatIndexC` for display, and the snapshot handed to the engine
 * deliberately omits it so the engine derives its own. That is only safe if both derivations
 * agree, so the end-to-end assertion runs a real `assessRisk` over the real snapshot and
 * compares the engine's heat index to the one the screen would print. This replaces the
 * `mock environment data is physically self-consistent` block that used to guard the
 * hardcoded `ENVIRONMENT` constant.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

import { readCachedEnvironment } from '@/environment/cache';
import { fetchLiveEnvironment, toEnvironmentSnapshot } from '@/environment/service';
import { assessRisk, computeHeatIndexC, type EnvironmentSnapshot } from '@/risk';

// Hoisted above the imports by babel-plugin-jest-hoist, so `Location` above is already the
// mocked copy. `AsyncStorage` is mocked globally in `jest/setup-after-env.js`, so the cache
// assertions below run against the package's own in-memory implementation.
jest.mock('expo-location', () => ({
  ...jest.requireActual('expo-location'),
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

const mockedLocation = Location as jest.Mocked<typeof Location>;

const NOW = 1_766_000_000_000;
const KEY = 'test-key';

/** Chennai, as the device would report it before rounding. */
const DEVICE_FIX = {
  coords: { latitude: 13.0827, longitude: 80.2707, accuracy: 900, altitude: null, heading: null, speed: null },
  timestamp: NOW - 60_000,
} as unknown as Location.LocationObject;

type Handler = { status?: number; body?: unknown; throws?: Error };

/** A fetch that answers the two endpoints independently, so either can fail alone. */
function makeFetch(weather: Handler, air: Handler) {
  const urls: string[] = [];
  const impl = jest.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const handler = url.includes('air_pollution') ? air : weather;
    if (handler.throws) throw handler.throws;
    const status = handler.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => handler.body,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, urls };
}

const HOT_WEATHER = {
  name: 'Chennai',
  dt: 1_765_999_280, // 12 minutes before NOW
  main: { temp: 38, humidity: 62 },
};

/**
 * PM2.5 of 79.8 µg/m³ is EPA AQI 168 ("Unhealthy"). The provider's own band for the same
 * air is 4 — the number that must never reach the engine.
 */
const DIRTY_AIR = {
  list: [
    {
      dt: 1_765_999_280,
      main: { aqi: 4 },
      components: { pm2_5: 79.8, pm10: 90, o3: 41.2, no2: 18.4, so2: 5.1, co: 620.8 },
    },
  ],
};

const MILD_WEATHER = { name: 'Wellington', dt: 1_765_999_280, main: { temp: 18, humidity: 55 } };
const CLEAN_AIR = { list: [{ dt: 1_765_999_280, main: { aqi: 1 }, components: { pm2_5: 5, pm10: 12 } }] };

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY = KEY;

  mockedLocation.getForegroundPermissionsAsync.mockResolvedValue({
    granted: true,
    canAskAgain: true,
    status: 'granted',
    expires: 'never',
  } as unknown as Location.LocationPermissionResponse);
  mockedLocation.hasServicesEnabledAsync.mockResolvedValue(true);
  mockedLocation.getLastKnownPositionAsync.mockResolvedValue(DEVICE_FIX);
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY;
});

describe('fetchLiveEnvironment', () => {
  it('assembles one observation from location, weather, and air quality', async () => {
    const { impl } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    expect(environment).toMatchObject({
      location: 'Chennai',
      coordinates: { latitude: 13.08, longitude: 80.27 },
      locationSource: 'device',
      observedAt: 1_765_999_280_000,
      fetchedAt: NOW,
      tempC: 38,
      humidity: 62,
      heatIndexBand: { label: 'Extreme Danger', level: 'red' },
      aqi: 168,
      aqiCategory: { label: 'Unhealthy', level: 'red' },
      aqiBasis: 'pm2_5',
      pollutants: { pm2_5: 79.8, pm10: 90 },
    });
    expect(environment.heatIndexC).toBeCloseTo(56.4, 1);
    expect(environment).not.toHaveProperty('locationFallbackReason');
  });

  it('computes the EPA index rather than passing the provider’s 1–5 band through', async () => {
    const { impl } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    const { aqi } = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    // 4 is what the response literally contains, and would sit silently below the engine's
    // `aqiNeutralBelow` of 100 forever.
    expect(aqi).not.toBe(4);
    expect(aqi).toBe(168);
  });

  it('sends the rounded coordinates, not the device’s own precision', async () => {
    const { impl, urls } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const params = new URL(url).searchParams;
      expect(params.get('lat')).toBe('13.08');
      expect(params.get('lon')).toBe('80.27');
    }
  });

  it('keeps the weather when air quality fails, because heat is the flag that escalates', async () => {
    const { impl } = makeFetch({ body: HOT_WEATHER }, { status: 500 });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    expect(environment.tempC).toBe(38);
    expect(environment.heatIndexBand?.label).toBe('Extreme Danger');
    // Null rather than 0: a zero would assert pristine air and actively reassure.
    expect(environment.aqi).toBeNull();
    expect(environment.aqiCategory).toBeNull();
    expect(environment.pollutants).toBeNull();
    expect(environment.advisories.map((a) => a.id)).toEqual(['heat-index']);
  });

  it('fails when weather fails, and preserves the failure kind for the screen', async () => {
    const { impl } = makeFetch({ status: 401 }, { body: DIRTY_AIR });
    await expect(fetchLiveEnvironment({ now: NOW, fetchImpl: impl })).rejects.toMatchObject({
      kind: 'auth',
    });
  });

  it('falls back to the provider band only when concentrations are missing', async () => {
    const { impl } = makeFetch(
      { body: HOT_WEATHER },
      { body: { list: [{ dt: 1_765_999_280, main: { aqi: 5 } }] } },
    );
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    expect(environment.aqiBasis).toBe('owm_index');
    expect(environment.aqi).toBe(250);
    expect(environment.aqiCategory?.label).toBe('Very Unhealthy');
  });

  it('uses the call time when the provider omits its observation time', async () => {
    // Better than 1970, and honest: it is the closest instant we can actually vouch for.
    const { impl } = makeFetch({ body: { main: { temp: 30, humidity: 40 } } }, { body: DIRTY_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });
    expect(environment.observedAt).toBe(NOW);
  });

  it('names the fallback city when the provider has no place name for it', async () => {
    mockedLocation.getForegroundPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: false,
      status: 'denied',
      expires: 'never',
    } as unknown as Location.LocationPermissionResponse);

    const { impl } = makeFetch({ body: { main: { temp: 38, humidity: 62 } } }, { body: DIRTY_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    expect(environment).toMatchObject({
      location: 'Chennai',
      locationSource: 'fallback',
      locationFallbackReason: 'permission_denied',
    });
  });

  it('describes a device fix by coordinates when the provider has no name', async () => {
    const { impl } = makeFetch({ body: { main: { temp: 38, humidity: 62 } } }, { body: DIRTY_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });
    expect(environment.location).toBe('13.08°N, 80.27°E');
  });

  it('signs the hemispheres correctly', async () => {
    mockedLocation.getLastKnownPositionAsync.mockResolvedValue({
      coords: { latitude: -33.8688, longitude: -70.6693, accuracy: 900 },
      timestamp: NOW,
    } as unknown as Location.LocationObject);

    const { impl } = makeFetch({ body: { main: { temp: 20, humidity: 50 } } }, { body: CLEAN_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });
    expect(environment.location).toBe('33.87°S, 70.67°W');
  });

  it('reuses a pre-resolved location rather than asking the OS again', async () => {
    const { impl, urls } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    await fetchLiveEnvironment({
      now: NOW,
      fetchImpl: impl,
      location: { coordinates: { latitude: 28.61, longitude: 77.21 }, source: 'device' },
    });

    expect(mockedLocation.getForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(new URL(urls[0]).searchParams.get('lat')).toBe('28.61');
  });

  it('does not raise a permission dialog when told not to', async () => {
    mockedLocation.getForegroundPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
      status: 'undetermined',
      expires: 'never',
    } as unknown as Location.LocationPermissionResponse);

    const { impl } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    await fetchLiveEnvironment({ now: NOW, fetchImpl: impl, canPrompt: false });

    expect(mockedLocation.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe('the offline cache it maintains', () => {
  it('records a successful observation, so the next cold launch has something true to show', async () => {
    const { impl } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    await expect(readCachedEnvironment(NOW)).resolves.toEqual(environment);
  });

  it('leaves the previous entry intact when a fetch fails', async () => {
    // Last known *good*, not last attempt: a failed refresh must not erase the reading
    // that is currently the only thing standing between the user and an empty screen.
    const good = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    const first = await fetchLiveEnvironment({ now: NOW, fetchImpl: good.impl });

    const bad = makeFetch({ status: 503 }, { body: DIRTY_AIR });
    await expect(
      fetchLiveEnvironment({ now: NOW + 60_000, fetchImpl: bad.impl }),
    ).rejects.toBeDefined();

    await expect(readCachedEnvironment(NOW + 60_000)).resolves.toEqual(first);
  });
});

describe('advisories', () => {
  it('attributes each one to what actually produced it', async () => {
    const { impl } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    const { advisories } = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    expect(advisories.map((a) => ({ id: a.id, source: a.source, level: a.level }))).toEqual([
      { id: 'heat-index', source: 'NOAA heat index', level: 'red' },
      { id: 'air-quality', source: 'US EPA AQI (estimated)', level: 'red' },
    ]);
    expect(advisories[0].title).toBe('Extreme Danger heat — feels like 56°C');
    expect(advisories[1].title).toBe('Unhealthy air — AQI 168');
  });

  it('never attributes OpenWeatherMap data to a government agency', async () => {
    // The mock this replaced labelled its advisories "IMD" and "CPCB". Attributing a
    // heat-wave warning to India's meteorological department when it came from a
    // third-party API is a misrepresentation with real weight behind it, not a cosmetic
    // label — and the app has contacted neither agency.
    const { impl } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    const { advisories } = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    for (const advisory of advisories) {
      expect(advisory.source).not.toMatch(/IMD|CPCB|AirNow|NDMA/i);
    }
  });

  it('stays quiet in ordinary weather, so a firing card still means something', async () => {
    const { impl } = makeFetch({ body: MILD_WEATHER }, { body: CLEAN_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    expect(environment.heatIndexBand?.label).toBe('Normal');
    expect(environment.aqiCategory?.label).toBe('Good');
    expect(environment.advisories).toEqual([]);
  });

  it('reports cool weather as normal rather than as incomplete data', async () => {
    // Below 80 °F the NOAA regression is not used at all, and a null heat index here would
    // make the engine say "Weather data is incomplete" for every temperate climate.
    const { impl } = makeFetch({ body: { main: { temp: 8, humidity: 80 } } }, { body: CLEAN_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    expect(environment.heatIndexC).not.toBeNull();
    expect(environment.heatIndexBand).toEqual({ label: 'Normal', level: 'green' });
  });
});

describe('toEnvironmentSnapshot', () => {
  async function snapshotFor(weather: Handler, air: Handler): Promise<EnvironmentSnapshot> {
    const { impl } = makeFetch(weather, air);
    return toEnvironmentSnapshot(await fetchLiveEnvironment({ now: NOW, fetchImpl: impl }));
  }

  it('forwards only the measurements, never the presentation fields', async () => {
    const snapshot = await snapshotFor({ body: HOT_WEATHER }, { body: DIRTY_AIR });

    expect(snapshot).toEqual({
      tempC: 38,
      humidity: 62,
      aqi: 168,
      observedAt: 1_765_999_280_000,
    });
    // A rule keying off any of these would be reading a string this module chose rather
    // than a measurement.
    for (const field of ['location', 'coordinates', 'heatIndexBand', 'aqiCategory', 'advisories']) {
      expect(snapshot).not.toHaveProperty(field);
    }
  });

  it('omits the heat index so the engine derives it, and the two cannot disagree', async () => {
    const snapshot = await snapshotFor({ body: HOT_WEATHER }, { body: DIRTY_AIR });

    // OpenWeatherMap publishes no NOAA heat index — `feels_like` is a different model —
    // so forwarding our own derived figure would launder a computation into an apparent
    // measurement, and the engine re-bands whatever it is given.
    expect(snapshot).not.toHaveProperty('heatIndexC');
    expect(snapshot.heatIndexC).toBeUndefined();
  });

  it('omits a missing AQI entirely rather than sending zero', async () => {
    const snapshot = await snapshotFor({ body: HOT_WEATHER }, { status: 500 });

    // The standing adapter rule: absent stays absent. The engine reads a missing AQI as
    // "do not amplify" and a zero as "pristine air".
    expect(snapshot).not.toHaveProperty('aqi');
    expect(snapshot).toEqual({ tempC: 38, humidity: 62, observedAt: 1_765_999_280_000 });
  });

  it('hands the engine the same heat index the screen prints', async () => {
    const { impl } = makeFetch({ body: HOT_WEATHER }, { body: DIRTY_AIR });
    const environment = await fetchLiveEnvironment({ now: NOW, fetchImpl: impl });

    const assessment = assessRisk({
      readings: [],
      environment: toEnvironmentSnapshot(environment),
      now: NOW,
    });

    // Exact equality, not approximate: both sides call `computeHeatIndexC` on the same two
    // numbers, which is the property that makes omitting `heatIndexC` safe.
    expect(assessment.heatIndexC).toBe(environment.heatIndexC);
    expect(assessment.heatIndexC).toBe(computeHeatIndexC(38, 62));
    expect(assessment.heatIndexBand).toEqual(environment.heatIndexBand);
  });
});
