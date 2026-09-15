/**
 * Location fix for an emergency alert (PRD §7.2.5: "with GPS coordinates").
 *
 * ## Why this is not `src/environment/location.ts`
 * That module is coarse by design and by two independent mechanisms — `Accuracy.Low` plus
 * truncation to 2 decimal places — because it sends coordinates to a third-party weather API
 * for a feature that gains nothing from precision (PRD §7.2.3). Reusing it here would put a
 * ~1.1 km cell in an emergency message, which in a dense Indian city is an area holding tens
 * of thousands of people. That is not a location a responder can act on.
 *
 * PRD §7.2.6 draws exactly this line: coarse location for environmental calls, and "SOS
 * messages are the only outbound data path carrying personal info, and only on explicit
 * trigger". So this module requests the best fix the OS will give, does **not** round it, and
 * is only ever called from a committed SOS dispatch — never on a screen, never on a timer.
 *
 * Two consequences worth being explicit about:
 *
 * 1. `app.json` no longer blocks `ACCESS_FINE_LOCATION` on Android, because blocking it
 *    capped every fix in the app at ~1–3 km and made the coordinates in an emergency SMS
 *    decorative. The environment feed still asks for `Accuracy.Low` and still rounds, so its
 *    behaviour is unchanged; the permission is now *available* to this path rather than
 *    granted to that one.
 * 2. The user may still have granted only approximate location. That is not an error — the
 *    fix comes back with a large `accuracyM`, the message reports it, and the recipient learns
 *    they have a suburb rather than a doorstep. {@link SosLocation.accuracyM} exists for this.
 */

import * as Location from 'expo-location';

import { LOCATION_TIMEOUT_MS } from './config';
import type { SosLocation, SosLocationResult } from './types';

/**
 * Race a promise against a timeout without leaving the timer pending.
 *
 * Same reasoning as `environment/location.ts`: a bare `Promise.race` against `setTimeout`
 * keeps the loser's timer alive and React Native logs an open-handle warning long after the
 * call returned.
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

function toSosLocation(position: Location.LocationObject | null): SosLocation | null {
  const coords = position?.coords;
  if (!coords) return null;
  if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return null;

  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracyM:
      typeof coords.accuracy === 'number' && Number.isFinite(coords.accuracy)
        ? coords.accuracy
        : null,
    timestamp: Number.isFinite(position?.timestamp) ? position.timestamp : 0,
  };
}

export type ResolveSosLocationOptions = {
  readonly timeoutMs?: number;
};

/**
 * The best position available inside the timeout, unrounded.
 *
 * Never rejects: every failure resolves to `{ ok: false, reason }` so the dispatch can go out
 * without coordinates. An SOS that aborts because the GPS was slow is strictly worse than one
 * that says "location unavailable" — the contact still knows to call.
 *
 * Unlike the environment feed, this does **not** try `getLastKnownPositionAsync` first. A
 * cached fix from twenty minutes ago is fine for weather and actively misleading for an
 * emergency: it would place someone where they were, not where they are, with an accuracy
 * figure that describes the old fix. Fresh or nothing.
 */
export async function resolveSosLocation(
  options: ResolveSosLocationOptions = {},
): Promise<SosLocationResult> {
  const timeoutMs = options.timeoutMs ?? LOCATION_TIMEOUT_MS;

  try {
    const existing = await Location.getForegroundPermissionsAsync();
    let granted = existing.granted;

    if (!granted) {
      // Prompting is right here even though the environment feed avoids it: the user has
      // either pressed an emergency button or is inside a 30-second cancel window they can
      // see, so a permission dialog is expected rather than an ambush.
      if (existing.canAskAgain === false) {
        return { ok: false, reason: 'permission_denied' };
      }
      granted = (await Location.requestForegroundPermissionsAsync()).granted;
    }

    if (!granted) return { ok: false, reason: 'permission_denied' };

    if (!(await Location.hasServicesEnabledAsync())) {
      return { ok: false, reason: 'services_disabled' };
    }

    const position = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }),
      timeoutMs,
    );

    const location = toSosLocation(position);
    if (location === null) return { ok: false, reason: 'timeout' };

    return { ok: true, location };
  } catch {
    // The native module throws for reasons that are not actionable in-app — no hardware, a
    // revoked permission mid-call, an emulator with no mock location. In all of them the
    // right product behaviour is to send the alert without coordinates.
    return { ok: false, reason: 'unavailable' };
  }
}
