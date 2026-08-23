/**
 * OpenWeatherMap client tests.
 *
 * Three groups of things are worth pinning here, and only one of them is ordinary parsing:
 *
 * 1. **Unit contracts.** `units=metric` on the weather call and `dt`-is-seconds on both.
 *    Both failures are silent and plausible: without `units=metric` the API returns Kelvin,
 *    so a mild day arrives as 300 and bands as Extreme Danger; reading `dt` as milliseconds
 *    puts every observation in January 1970, which makes the engine's staleness check reject
 *    data that is actually current. Neither throws.
 * 2. **Key confinement.** The key is a query parameter, so it is inside the request URL, and
 *    fetch failures habitually quote the URL they failed on. A test asserts the key value
 *    appears in no error message.
 * 3. **Hostile payloads.** These are two network responses parsed on a mobile device. A
 *    string where a number belongs must not reach the AQI breakpoint lookup, and a missing
 *    temperature must produce an error rather than a `LiveEnvironment` built around a hole.
 */

import {
  EnvironmentError,
  fetchAirQuality,
  fetchWeather,
  readApiKey,
} from '@/environment/openweather';

const KEY = 'test-key-abcdef0123456789';
const COORDS = { latitude: 13.08, longitude: 80.27 };

/** Jest does not load `.env.local`, so the key is absent unless a test sets it. */
beforeEach(() => {
  process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY = KEY;
});

afterEach(() => {
  delete process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY;
});

type Json = Record<string, unknown>;

/** A fetch that answers once with `body`, and records the URL it was called with. */
function jsonFetch(body: Json, init: { status?: number } = {}) {
  const calls: string[] = [];
  const impl = jest.fn(async (input: unknown) => {
    calls.push(String(input));
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const WEATHER_BODY: Json = {
  name: 'Chennai',
  dt: 1_766_000_000,
  main: { temp: 38, humidity: 62, feels_like: 45 },
};

const AIR_BODY: Json = {
  list: [
    {
      dt: 1_766_000_060,
      main: { aqi: 4 },
      components: { pm2_5: 79.8, pm10: 90, o3: 41.2, no2: 18.4, so2: 5.1, co: 620.8 },
    },
  ],
};

describe('readApiKey', () => {
  it('is null when unset, so the caller reports a config problem rather than calling with "undefined"', () => {
    delete process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY;
    expect(readApiKey()).toBeNull();
  });

  it('is null for a blank value', () => {
    process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY = '   ';
    expect(readApiKey()).toBeNull();
  });

  it('trims, because a trailing newline in .env.local turns into a bewildering 401', () => {
    process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY = ` ${KEY}\n`;
    expect(readApiKey()).toBe(KEY);
  });
});

describe('fetchWeather', () => {
  it('asks for metric units, or a mild day would arrive in Kelvin and band as extreme heat', async () => {
    const { impl, calls } = jsonFetch(WEATHER_BODY);
    await fetchWeather(COORDS, { fetchImpl: impl });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]);
    expect(url.origin + url.pathname).toBe('https://api.openweathermap.org/data/2.5/weather');
    expect(url.searchParams.get('units')).toBe('metric');
    expect(url.searchParams.get('lat')).toBe('13.08');
    expect(url.searchParams.get('lon')).toBe('80.27');
    expect(url.searchParams.get('appid')).toBe(KEY);
  });

  it('reads temperature, humidity, place name, and the observation time', async () => {
    const { impl } = jsonFetch(WEATHER_BODY);
    await expect(fetchWeather(COORDS, { fetchImpl: impl })).resolves.toEqual({
      tempC: 38,
      humidity: 62,
      location: 'Chennai',
      // `dt` is epoch **seconds**. Read as milliseconds this becomes 1970-01-21, and every
      // freshness check downstream would reject current data as 56 years stale.
      observedAt: 1_766_000_000_000,
    });
  });

  it('leaves the observation time null rather than guessing when `dt` is absent', async () => {
    const { impl } = jsonFetch({ main: { temp: 30, humidity: 50 } });
    const observation = await fetchWeather(COORDS, { fetchImpl: impl });
    expect(observation.observedAt).toBeNull();
    expect(observation.location).toBeNull();
  });

  it.each([
    ['a missing temperature', { main: { humidity: 62 } }],
    ['a missing humidity', { main: { temp: 38 } }],
    ['a string temperature', { main: { temp: '38', humidity: 62 } }],
    ['no main block at all', { name: 'Chennai' }],
    ['an array payload', []],
    ['a null payload', null],
  ])('rejects %s instead of manufacturing an observation', async (_label, body) => {
    const { impl } = jsonFetch(body as Json);
    await expect(fetchWeather(COORDS, { fetchImpl: impl })).rejects.toMatchObject({
      kind: 'response',
    });
  });

  it.each([
    [401, 'auth'],
    [429, 'rate_limit'],
    [500, 'network'],
    [503, 'network'],
    [404, 'response'],
  ])('maps HTTP %s to the %s failure kind', async (status, kind) => {
    const { impl } = jsonFetch({}, { status: status as number });
    await expect(fetchWeather(COORDS, { fetchImpl: impl })).rejects.toMatchObject({ kind });
  });

  it('fails as a config problem without calling out, when no key is set', async () => {
    delete process.env.EXPO_PUBLIC_OPENWEATHER_API_KEY;
    const { impl, calls } = jsonFetch(WEATHER_BODY);

    await expect(fetchWeather(COORDS, { fetchImpl: impl })).rejects.toMatchObject({
      kind: 'config',
    });
    // A request without a key is a guaranteed 401; not making it keeps the log clean and
    // the diagnosis unambiguous.
    expect(calls).toHaveLength(0);
  });

  it('never puts the key in an error message', async () => {
    // The key travels as a query parameter, and a fetch rejection commonly quotes the URL
    // it failed on. Interpolating the underlying error would put the key into logs, crash
    // reports, and screenshots.
    const failing = jest.fn(async () => {
      throw new TypeError(`Network request failed: GET https://api.openweathermap.org/x?appid=${KEY}`);
    }) as unknown as typeof fetch;

    const errors: string[] = [];
    for (const call of [
      () => fetchWeather(COORDS, { fetchImpl: failing }),
      () => fetchAirQuality(COORDS, { fetchImpl: failing }),
    ]) {
      await call().catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
      });
    }

    expect(errors).toHaveLength(2);
    for (const message of errors) {
      expect(message).not.toContain(KEY);
      expect(message).toBe('Could not reach the weather service.');
    }
  });

  it('reports a hung request as a timeout once its own deadline passes', async () => {
    // Mirrors what a real fetch does with an aborted signal, which is the only way the
    // timeout is observable from outside.
    const hanging = jest.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;

    await expect(
      fetchWeather(COORDS, { fetchImpl: hanging, timeoutMs: 10 }),
    ).rejects.toMatchObject({ kind: 'network', message: 'Weather request timed out.' });
  });

  it('honours a caller signal as well as its own timeout', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;

    const hanging = jest.fn(
      (_input: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          observed = init?.signal;
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;

    const pending = fetchWeather(COORDS, { fetchImpl: hanging, signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'network' });
    // The signal handed to fetch is the composed one, not the caller's: replacing it would
    // drop the timeout, and a superseded refresh would hang until the network gave up.
    expect(observed).not.toBe(controller.signal);
    expect(observed?.aborted).toBe(true);
  });
});

describe('fetchAirQuality', () => {
  it('returns concentrations and the provider band, not an index', async () => {
    const { impl, calls } = jsonFetch(AIR_BODY);
    const observation = await fetchAirQuality(COORDS, { fetchImpl: impl });

    expect(new URL(calls[0]).pathname).toBe('/data/2.5/air_pollution');
    expect(observation).toEqual({
      pollutants: { pm2_5: 79.8, pm10: 90, o3: 41.2, no2: 18.4, so2: 5.1, co: 620.8 },
      owmIndex: 4,
      observedAt: 1_766_000_060_000,
    });
  });

  it('drops non-numeric and unknown components rather than passing them through', async () => {
    const { impl } = jsonFetch({
      list: [
        {
          dt: 1_766_000_060,
          main: { aqi: 2 },
          components: {
            pm2_5: '79.8',
            pm10: 90,
            o3: null,
            no2: Number.NaN,
            nh3: 12.5,
            __proto__: { polluted: true },
          },
        },
      ],
    });

    const observation = await fetchAirQuality(COORDS, { fetchImpl: impl });
    // A string concentration reaching the EPA breakpoint lookup would compare with `<=`
    // against numbers and land in an arbitrary band.
    expect(observation.pollutants).toEqual({ pm10: 90 });
    expect(Object.keys(observation.pollutants)).toEqual(['pm10']);
  });

  it('leaves the provider band undefined when it is absent, so the AQI fallback stays off', async () => {
    const { impl } = jsonFetch({ list: [{ components: { pm2_5: 10 } }] });
    const observation = await fetchAirQuality(COORDS, { fetchImpl: impl });
    expect(observation.owmIndex).toBeUndefined();
    expect(observation.observedAt).toBeNull();
  });

  it.each([
    ['an empty list', { list: [] }],
    ['no list', {}],
    ['a non-array list', { list: { components: {} } }],
  ])('rejects %s', async (_label, body) => {
    const { impl } = jsonFetch(body as Json);
    await expect(fetchAirQuality(COORDS, { fetchImpl: impl })).rejects.toBeInstanceOf(
      EnvironmentError,
    );
  });

  it('yields no pollutants, rather than an error, when the entry carries no components', async () => {
    // Distinct from the cases above: there *is* a reading, it just has nothing usable in
    // it. `estimateAqi` returns null for that, which the screen shows as an em dash.
    const { impl } = jsonFetch({ list: [{ dt: 1_766_000_060, main: { aqi: 3 } }] });
    const observation = await fetchAirQuality(COORDS, { fetchImpl: impl });
    expect(observation.pollutants).toEqual({});
    expect(observation.owmIndex).toBe(3);
  });
});
