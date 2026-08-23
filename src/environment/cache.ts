/**
 * Last-known-good persistence for the environment feed (PRD §7.2.3: "cache the last
 * successful response locally so the app still works offline").
 *
 * ## Why validate on read
 * The stored blob is JSON written by a *previous build* of the app. Trusting its shape is
 * how a field rename turns into `undefined.toFixed()` on the Environment screen for every
 * existing install while every test passes on the new schema. So the key carries a schema
 * version, and reads are validated field by field — an unreadable or outdated entry is
 * treated exactly like a cache miss, which is a state the caller already handles.
 *
 * ## Why there is an age ceiling
 * "Works offline" means the last real reading stays useful through a tunnel, a dead zone,
 * or a night with the radio off — not that a fortnight-old heat index gets presented as
 * current. The engine's own `env.maxStaleMs` (60 min) already stops a stale observation
 * from driving a flag, and the screen shows the observation age, but past a day the data
 * is not weather any more. Beyond `CACHE_MAX_AGE_MS` the entry is dropped and the screen
 * says it has nothing, which is true.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { LiveEnvironment } from '@/environment/types';

/**
 * Bump the suffix on any breaking change to `LiveEnvironment`. Old entries then miss
 * rather than deserialise into a half-populated object.
 */
export const CACHE_KEY = 'phc.environment.last-known-good.v1';

/** Past a day, a cached observation is history rather than weather. */
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNullableFinite(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value);
}

/**
 * Structural check against the fields the screen and the engine actually read.
 *
 * Only the load-bearing ones are verified. A missing `advisories` array is repaired to
 * empty by the caller below rather than discarding an otherwise good observation, because
 * losing a heat reading over a cosmetic field would be the wrong trade.
 */
function isUsableEnvironment(value: unknown): value is LiveEnvironment {
  if (typeof value !== 'object' || value === null) return false;
  const env = value as Record<string, unknown>;

  const coordinates = env.coordinates as Record<string, unknown> | null | undefined;

  return (
    typeof env.location === 'string' &&
    isFiniteNumber(env.tempC) &&
    isFiniteNumber(env.humidity) &&
    isFiniteNumber(env.observedAt) &&
    isFiniteNumber(env.fetchedAt) &&
    isNullableFinite(env.heatIndexC) &&
    isNullableFinite(env.aqi) &&
    (env.locationSource === 'device' || env.locationSource === 'fallback') &&
    typeof coordinates === 'object' &&
    coordinates !== null &&
    isFiniteNumber(coordinates.latitude) &&
    isFiniteNumber(coordinates.longitude)
  );
}

/**
 * The last successful observation, or null.
 *
 * @param now Evaluation instant in epoch ms, injected rather than read from a clock so the
 *   age ceiling is testable without faking timers.
 */
export async function readCachedEnvironment(now: number): Promise<LiveEnvironment | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (raw === null) return null;

    const parsed: unknown = JSON.parse(raw);
    if (!isUsableEnvironment(parsed)) return null;

    // A `fetchedAt` in the future means the device clock moved backwards since the write.
    // Treat it as a miss rather than computing a negative age and calling it fresh.
    const age = now - parsed.fetchedAt;
    if (age < 0 || age > CACHE_MAX_AGE_MS) return null;

    return {
      ...parsed,
      advisories: Array.isArray(parsed.advisories) ? parsed.advisories : [],
    };
  } catch {
    // Corrupt JSON, storage unavailable, quota errors. A cache is an optimisation; it must
    // never be the reason the feed fails.
    return null;
  }
}

export async function writeCachedEnvironment(environment: LiveEnvironment): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(environment));
  } catch {
    // Same reasoning: a failed write costs the next offline launch its fallback, which is
    // not worth surfacing an error over a successful fetch the user can already see.
  }
}

export async function clearCachedEnvironment(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // Nothing actionable.
  }
}
