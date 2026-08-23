/**
 * Offline cache tests.
 *
 * The interesting cases are all about *rejecting* data rather than storing it. This blob is
 * written by one build of the app and read by the next, so the read path is a trust boundary
 * with the app's own past self: a field renamed in a release turns into `undefined.toFixed()`
 * on the Environment screen for every existing install, and every test still passes against
 * the new schema. So the validation is asserted field by field, and each rejection is
 * asserted to behave as a cache *miss* — a state the caller already handles — rather than as
 * an error.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  CACHE_KEY,
  CACHE_MAX_AGE_MS,
  clearCachedEnvironment,
  readCachedEnvironment,
  writeCachedEnvironment,
} from '@/environment/cache';
import { FIXTURE_NOW, liveEnvironment } from '@/environment/__tests__/fixtures';

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

/** Write a raw string past the typed API, the way a previous build's schema would arrive. */
async function seed(raw: string) {
  await AsyncStorage.setItem(CACHE_KEY, raw);
}

describe('round trip', () => {
  it('returns exactly what was written', async () => {
    const environment = liveEnvironment({
      advisories: [
        {
          id: 'heat-index',
          source: 'NOAA heat index',
          title: 'Extreme Danger heat — feels like 56°C',
          detail: 'Stay indoors.',
          level: 'red',
        },
      ],
    });

    await writeCachedEnvironment(environment);
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toEqual(environment);
  });

  it('survives the fields that are legitimately null', async () => {
    // A response with no air-quality reading is ordinary, and `null` must round-trip as
    // null rather than being repaired into a number — `aqi: 0` would assert pristine air.
    const environment = liveEnvironment({ aqi: null, aqiCategory: null, aqiBasis: null, pollutants: null });

    await writeCachedEnvironment(environment);
    const restored = await readCachedEnvironment(FIXTURE_NOW);
    expect(restored?.aqi).toBeNull();
    expect(restored?.pollutants).toBeNull();
  });

  it('keeps the fallback-reason field, so an offline launch still says whose location it is', async () => {
    const environment = liveEnvironment({
      locationSource: 'fallback',
      locationFallbackReason: 'permission_denied',
    });

    await writeCachedEnvironment(environment);
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toMatchObject({
      locationSource: 'fallback',
      locationFallbackReason: 'permission_denied',
    });
  });

  it('is a miss when nothing was ever written', async () => {
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toBeNull();
  });

  it('is a miss after clearing', async () => {
    await writeCachedEnvironment(liveEnvironment());
    await clearCachedEnvironment();
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toBeNull();
  });
});

describe('age', () => {
  it('serves a reading from earlier today, which is the whole point of the cache', async () => {
    const environment = liveEnvironment({ fetchedAt: FIXTURE_NOW - CACHE_MAX_AGE_MS + 1 });
    await writeCachedEnvironment(environment);
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.not.toBeNull();
  });

  it('drops one from last week, because that is history rather than weather', async () => {
    await writeCachedEnvironment(liveEnvironment({ fetchedAt: FIXTURE_NOW - CACHE_MAX_AGE_MS - 1 }));
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toBeNull();
  });

  it('accepts the boundary exactly, so the ceiling is inclusive rather than ambiguous', async () => {
    await writeCachedEnvironment(liveEnvironment({ fetchedAt: FIXTURE_NOW - CACHE_MAX_AGE_MS }));
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.not.toBeNull();
  });

  it('drops an entry from the future rather than computing a negative age', async () => {
    // The device clock moved backwards since the write — a timezone fix, an NTP
    // correction, or a user setting the date. A negative age would otherwise read as the
    // freshest possible data.
    await writeCachedEnvironment(liveEnvironment({ fetchedAt: FIXTURE_NOW + 1 }));
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toBeNull();
  });
});

describe('rejecting data a previous build might have written', () => {
  it.each([
    ['not JSON at all', 'not json {'],
    ['a JSON scalar', '42'],
    ['null', 'null'],
    ['an array', '[]'],
  ])('treats %s as a miss', async (_label, raw) => {
    await seed(raw);
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toBeNull();
  });

  it.each([
    'location',
    'tempC',
    'humidity',
    'observedAt',
    'fetchedAt',
    'locationSource',
    'coordinates',
  ])('treats a missing `%s` as a miss', async (field) => {
    const partial: Record<string, unknown> = { ...liveEnvironment() };
    delete partial[field];
    await seed(JSON.stringify(partial));
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toBeNull();
  });

  it.each([
    ['a string temperature', { tempC: '38' }],
    ['a NaN temperature, which JSON.stringify writes as null', { tempC: Number.NaN }],
    ['an unrecognised location source', { locationSource: 'guessed' }],
    ['coordinates that are not an object', { coordinates: '13.08,80.27' }],
    ['coordinates missing a longitude', { coordinates: { latitude: 13.08 } }],
    ['a non-numeric heat index that is not null', { heatIndexC: 'hot' }],
    ['an AQI written as a string', { aqi: '168' }],
  ])('treats %s as a miss', async (_label, patch) => {
    await seed(JSON.stringify({ ...liveEnvironment(), ...patch }));
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toBeNull();
  });

  it('repairs a missing advisories array rather than discarding a good reading', async () => {
    // The trade is deliberate: losing a real heat index over a cosmetic list would be the
    // wrong way round, and every consumer maps over this array.
    const partial: Record<string, unknown> = { ...liveEnvironment() };
    delete partial.advisories;
    await seed(JSON.stringify(partial));

    const restored = await readCachedEnvironment(FIXTURE_NOW);
    expect(restored).not.toBeNull();
    expect(restored?.advisories).toEqual([]);
  });

  it('repairs a non-array advisories field the same way', async () => {
    await seed(JSON.stringify({ ...liveEnvironment(), advisories: 'heat warning' }));
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toMatchObject({ advisories: [] });
  });
});

describe('storage failures', () => {
  it('reads as a miss when storage itself is unavailable', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('storage unavailable'));
    await expect(readCachedEnvironment(FIXTURE_NOW)).resolves.toBeNull();
  });

  it('never fails a successful fetch over a failed write', async () => {
    // The user can already see the fresh reading on screen; surfacing an error about the
    // copy that was meant to help them *later* would be noise.
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValue(new Error('quota exceeded'));
    await expect(writeCachedEnvironment(liveEnvironment())).resolves.toBeUndefined();
  });

  it('swallows a failed clear', async () => {
    jest.spyOn(AsyncStorage, 'removeItem').mockRejectedValue(new Error('nope'));
    await expect(clearCachedEnvironment()).resolves.toBeUndefined();
  });
});

describe('the key', () => {
  it('carries a schema version, so a breaking change misses instead of half-deserialising', () => {
    expect(CACHE_KEY).toMatch(/\.v\d+$/);
  });
});
