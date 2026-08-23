/**
 * Coarse device location for the environment feed (PRD §7.2.3).
 *
 * ## Coarse on purpose, twice over
 * PRD §7.2.3 asks for city/pincode-level precision, not precise GPS, and this enforces
 * that at two independent layers:
 *
 * 1. **Accuracy** — `Accuracy.Low` (~1 km) rather than `High`/`Balanced`, and
 *    `getLastKnownPositionAsync` is tried first so the common case costs no GPS fix at
 *    all.
 * 2. **Rounding** — coordinates are truncated to 2 decimal places (~1.1 km) *before* they
 *    are used. This is the layer that actually matters for privacy, because the
 *    coordinates are sent to a third-party API: without it, a "coarse" fix of
 *    13.0827, 80.2707 still identifies a street. With it, OpenWeatherMap sees a ~1 km
 *    cell. Weather and air quality do not vary meaningfully inside that cell, so nothing
 *    is lost. It also makes the cache key stable as the user moves around a
 *    neighbourhood.
 *
 * This is the same "no raw personal data leaves the device beyond what the feature needs"
 * posture the rest of the project holds; a precise coordinate is personal data.
 *
 * ## Why the manifest no longer enforces it
 * `app.json` used to block `ACCESS_FINE_LOCATION` outright, which made precise location
 * unobtainable app-wide. That stopped being tenable when SOS landed: PRD §7.2.5 requires GPS
 * coordinates in an emergency message and §11 makes "SMS received on a second phone with
 * location" a success metric, and a ~1–3 km fix is not a location a responder can act on. The
 * block is gone, so the guarantee for *this* module is now the two layers above rather than
 * the OS. Keep them. `src/sos/location.ts` is the only place that asks for a precise fix, and
 * it is only ever called from a committed dispatch.
 *
 * ## Graceful degradation
 * Permission denial is an ordinary outcome, not an error path — the app falls back to a
 * default city and reports `source: 'fallback'` with the reason, so the screen can say so
 * rather than presenting another city's heat warning as local.
 */

import * as Location from 'expo-location';

import type {
  Coordinates,
  LocationFallbackReason,
  ResolvedLocation,
} from '@/environment/types';

/**
 * Where to look when the device will not say.
 *
 * Chennai: the deployment context PRD §7.2.3 targets, and hot and polluted enough that the
 * fallback exercises the heat and AQI paths rather than showing four green cards. The
 * screen always labels this as a fallback, so it never masquerades as the user's location.
 */
export const FALLBACK_LOCATION = {
  coordinates: { latitude: 13.08, longitude: 80.27 },
  name: 'Chennai',
} as const;

/** ~1.1 km at the equator, and less as latitude increases. Pincode-scale. */
export const COORDINATE_DECIMALS = 2;

/**
 * A GPS fix can take a long time or never arrive indoors; the feed should fall back
 * rather than leave the screen spinning.
 */
const LOCATION_TIMEOUT_MS = 8_000;

export function roundCoordinates(coordinates: Coordinates): Coordinates {
  const factor = 10 ** COORDINATE_DECIMALS;
  return {
    latitude: Math.round(coordinates.latitude * factor) / factor,
    longitude: Math.round(coordinates.longitude * factor) / factor,
  };
}

function fallback(reason: LocationFallbackReason): ResolvedLocation {
  return { coordinates: FALLBACK_LOCATION.coordinates, source: 'fallback', reason };
}

/**
 * Resolve a timeout without leaving a pending timer behind.
 *
 * `Promise.race` does not cancel the loser, so a bare `race` against a `setTimeout` keeps
 * the timer alive and — on React Native — logs an open-handle warning long after the call
 * returned.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function coordinatesFrom(position: Location.LocationObject | null): Coordinates | null {
  const coords = position?.coords;
  if (!coords) return null;
  if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return null;
  return { latitude: coords.latitude, longitude: coords.longitude };
}

export type ResolveLocationOptions = {
  /**
   * When false, an ungranted permission resolves to the fallback without showing the OS
   * dialog. Used by the 30-minute background refresh, which must not pop a permission
   * prompt while the user is doing something else.
   */
  readonly canPrompt?: boolean;
  readonly timeoutMs?: number;
};

/**
 * The device's coarse position, or the fallback city.
 *
 * Never rejects. Every failure mode — denial, disabled location services, a fix that never
 * arrives, an unexpected throw from the native module — resolves to a usable
 * `ResolvedLocation`, because the environment feed degrading to a default city is far
 * better than the Environment screen showing an error where the weather should be.
 */
export async function resolveLocation(
  options: ResolveLocationOptions = {},
): Promise<ResolvedLocation> {
  const canPrompt = options.canPrompt ?? true;
  const timeoutMs = options.timeoutMs ?? LOCATION_TIMEOUT_MS;

  try {
    const existing = await Location.getForegroundPermissionsAsync();
    let granted = existing.granted;

    if (!granted) {
      // `canAskAgain: false` means the user has permanently denied; prompting again is a
      // no-op that the OS silently swallows, so skip straight to the fallback.
      if (!canPrompt || existing.canAskAgain === false) {
        return fallback('permission_denied');
      }
      const requested = await Location.requestForegroundPermissionsAsync();
      granted = requested.granted;
    }

    if (!granted) return fallback('permission_denied');

    if (!(await Location.hasServicesEnabledAsync())) {
      return fallback('services_disabled');
    }

    // Cheapest first: a cached OS fix is free, needs no radio, and at 1 km rounding is
    // indistinguishable from a fresh one unless the user has travelled.
    const lastKnown = coordinatesFrom(
      await Location.getLastKnownPositionAsync({ maxAge: 30 * 60 * 1000, requiredAccuracy: 3_000 }),
    );
    if (lastKnown) {
      return { coordinates: roundCoordinates(lastKnown), source: 'device' };
    }

    const current = coordinatesFrom(
      await withTimeout(
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }),
        timeoutMs,
      ),
    );
    if (current) {
      return { coordinates: roundCoordinates(current), source: 'device' };
    }

    return fallback('timeout');
  } catch {
    // Swallowed deliberately, and this is the one place in the module where that is right:
    // the native module can throw for reasons that are not actionable in-app (no
    // hardware, an emulator without a mock location, a revoked permission mid-call), and
    // in every one of them the correct product behaviour is the fallback city.
    return fallback('unavailable');
  }
}
