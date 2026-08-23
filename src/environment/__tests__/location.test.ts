/**
 * Coarse-location resolution tests.
 *
 * The two properties worth guarding here are unusual for a data-fetching module:
 *
 * 1. **It must never reject.** Every failure mode has to land on a usable
 *    `ResolvedLocation`, because an unhandled rejection here would take out the whole
 *    environment feed — including the cached reading that is the offline story — over a
 *    denied permission, which is an ordinary user choice rather than an error.
 * 2. **It must never ask for precise location.** That is a privacy promise made in three
 *    places (`app.json`'s blocked Android permission, the iOS reduced-accuracy flag, and
 *    the accuracy argument here) and the coordinates leave the device, so the accuracy
 *    argument and the 2-decimal rounding are both asserted rather than assumed.
 */

import * as Location from 'expo-location';

import {
  COORDINATE_DECIMALS,
  FALLBACK_LOCATION,
  resolveLocation,
  roundCoordinates,
} from '@/environment/location';

// Hoisted above the imports by babel-plugin-jest-hoist, so `Location` above is already the
// mocked copy. Only the async entry points are replaced; `Accuracy` stays real so the
// assertion about which accuracy is requested compares against expo-location's own enum
// ordering rather than against numbers this test made up.
jest.mock('expo-location', () => ({
  ...jest.requireActual('expo-location'),
  getForegroundPermissionsAsync: jest.fn(),
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

const mocked = Location as jest.Mocked<typeof Location>;

function permission(granted: boolean, canAskAgain = true) {
  return {
    granted,
    canAskAgain,
    status: granted ? 'granted' : 'denied',
    expires: 'never',
  } as unknown as Location.LocationPermissionResponse;
}

function position(latitude: number, longitude: number) {
  return {
    coords: { latitude, longitude, accuracy: 900, altitude: null, heading: null, speed: null },
    timestamp: 1_766_000_000_000,
  } as unknown as Location.LocationObject;
}

/** The happy path: permission already granted, services on, a cached OS fix available. */
function grantAndReturn(fix: Location.LocationObject | null) {
  mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(true));
  mocked.hasServicesEnabledAsync.mockResolvedValue(true);
  mocked.getLastKnownPositionAsync.mockResolvedValue(fix);
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.getCurrentPositionAsync.mockResolvedValue(position(0, 0));
});

describe('roundCoordinates', () => {
  it('reduces a street-level fix to a ~1 km cell before it can leave the device', () => {
    // 13.0827, 80.2707 identifies a street. This is the layer that actually delivers the
    // privacy promise, because these coordinates are sent to a third-party API.
    expect(roundCoordinates({ latitude: 13.0827, longitude: 80.2707 })).toEqual({
      latitude: 13.08,
      longitude: 80.27,
    });
  });

  it('rounds symmetrically across the equator and the prime meridian', () => {
    expect(roundCoordinates({ latitude: -33.8688, longitude: -70.6693 })).toEqual({
      latitude: -33.87,
      longitude: -70.67,
    });
  });

  it('never emits more than the documented precision', () => {
    const samples = [
      { latitude: 51.500729, longitude: -0.124625 },
      { latitude: 0.000001, longitude: 179.999999 },
      { latitude: -0.005, longitude: 0.005 },
    ];
    for (const sample of samples) {
      const rounded = roundCoordinates(sample);
      for (const value of [rounded.latitude, rounded.longitude]) {
        const factor = 10 ** COORDINATE_DECIMALS;
        expect(Math.round(value * factor) / factor).toBe(value);
      }
    }
  });

  it('leaves the fallback city unchanged, so the default is no more precise than a real fix', () => {
    expect(roundCoordinates(FALLBACK_LOCATION.coordinates)).toEqual(
      FALLBACK_LOCATION.coordinates,
    );
  });
});

describe('resolveLocation with permission', () => {
  it('prefers the cached OS fix, which costs no radio and no GPS lock', async () => {
    grantAndReturn(position(13.0827, 80.2707));

    await expect(resolveLocation()).resolves.toEqual({
      coordinates: { latitude: 13.08, longitude: 80.27 },
      source: 'device',
    });
    expect(mocked.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  it('bounds the cached fix by age and accuracy rather than taking anything at all', async () => {
    grantAndReturn(position(13.0827, 80.2707));
    await resolveLocation();

    const [requirements] = mocked.getLastKnownPositionAsync.mock.calls[0];
    expect(requirements?.maxAge).toBe(30 * 60 * 1000);
    // Wide on purpose: at 2-decimal rounding a 3 km fix and a 10 m fix produce the same
    // coordinates, so demanding better would reject usable data for no gain.
    expect(requirements?.requiredAccuracy).toBe(3_000);
  });

  it('never requests better than Low accuracy', async () => {
    grantAndReturn(null);
    mocked.getCurrentPositionAsync.mockResolvedValue(position(13.0827, 80.2707));

    await expect(resolveLocation()).resolves.toEqual({
      coordinates: { latitude: 13.08, longitude: 80.27 },
      source: 'device',
    });

    const [options] = mocked.getCurrentPositionAsync.mock.calls[0];
    expect(options?.accuracy).toBe(Location.Accuracy.Low);
    // Compared against the enum's own ordering: Low(2) < Balanced(3) < High(4).
    expect(options?.accuracy as number).toBeLessThan(Location.Accuracy.Balanced);
    expect(options?.accuracy as number).toBeLessThan(Location.Accuracy.High);
  });

  it('asks the user once when permission has not been decided', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(false, true));
    mocked.requestForegroundPermissionsAsync.mockResolvedValue(permission(true));
    mocked.hasServicesEnabledAsync.mockResolvedValue(true);
    mocked.getLastKnownPositionAsync.mockResolvedValue(position(19.076, 72.8777));

    await expect(resolveLocation()).resolves.toEqual({
      coordinates: { latitude: 19.08, longitude: 72.88 },
      source: 'device',
    });
    expect(mocked.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('falls through to a live fix when the cached one carries unusable coordinates', async () => {
    // A native module returning NaN is not hypothetical on emulators without a mock
    // location; NaN would round to NaN and be sent to the API as "NaN".
    grantAndReturn(position(Number.NaN, 80.27));
    mocked.getCurrentPositionAsync.mockResolvedValue(position(13.0827, 80.2707));

    await expect(resolveLocation()).resolves.toEqual({
      coordinates: { latitude: 13.08, longitude: 80.27 },
      source: 'device',
    });
  });
});

describe('resolveLocation falling back', () => {
  it('reports a refusal rather than treating it as an error', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(false, true));
    mocked.requestForegroundPermissionsAsync.mockResolvedValue(permission(false, false));

    await expect(resolveLocation()).resolves.toEqual({
      coordinates: FALLBACK_LOCATION.coordinates,
      source: 'fallback',
      reason: 'permission_denied',
    });
  });

  it('does not re-prompt a permanent denial, which the OS silently swallows', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(false, false));

    const resolved = await resolveLocation();
    expect(resolved.reason).toBe('permission_denied');
    expect(mocked.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('does not raise a dialog on a background refresh', async () => {
    // A permission prompt appearing 30 minutes in, unprompted, while the user is on
    // another screen, is how a permission gets permanently denied.
    mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(false, true));

    const resolved = await resolveLocation({ canPrompt: false });
    expect(resolved.source).toBe('fallback');
    expect(mocked.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('distinguishes location services being off from permission being denied', async () => {
    mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(true));
    mocked.hasServicesEnabledAsync.mockResolvedValue(false);

    await expect(resolveLocation()).resolves.toMatchObject({
      source: 'fallback',
      reason: 'services_disabled',
    });
    expect(mocked.getLastKnownPositionAsync).not.toHaveBeenCalled();
  });

  it('gives up on a fix that never arrives instead of leaving the screen spinning', async () => {
    grantAndReturn(null);
    mocked.getCurrentPositionAsync.mockReturnValue(new Promise(() => {}));

    await expect(resolveLocation({ timeoutMs: 10 })).resolves.toMatchObject({
      source: 'fallback',
      reason: 'timeout',
    });
  });

  it('survives a throwing native module', async () => {
    mocked.getForegroundPermissionsAsync.mockRejectedValue(new Error('E_LOCATION_UNAVAILABLE'));

    await expect(resolveLocation()).resolves.toMatchObject({
      source: 'fallback',
      reason: 'unavailable',
    });
  });

  it('never rejects, whichever call blows up', async () => {
    const breakers: (() => void)[] = [
      () => mocked.getForegroundPermissionsAsync.mockRejectedValue(new Error('a')),
      () => {
        mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(true));
        mocked.hasServicesEnabledAsync.mockRejectedValue(new Error('b'));
      },
      () => {
        mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(true));
        mocked.hasServicesEnabledAsync.mockResolvedValue(true);
        mocked.getLastKnownPositionAsync.mockRejectedValue(new Error('c'));
      },
      () => {
        mocked.getForegroundPermissionsAsync.mockResolvedValue(permission(true));
        mocked.hasServicesEnabledAsync.mockResolvedValue(true);
        mocked.getLastKnownPositionAsync.mockResolvedValue(null);
        mocked.getCurrentPositionAsync.mockRejectedValue(new Error('d'));
      },
    ];

    for (const breaker of breakers) {
      jest.clearAllMocks();
      breaker();
      const resolved = await resolveLocation({ timeoutMs: 10 });
      expect(resolved.source).toBe('fallback');
      expect(resolved.coordinates).toEqual(FALLBACK_LOCATION.coordinates);
    }
  });

  it('falls back to somewhere the heat and air-quality paths actually exercise', () => {
    // A default in a temperate, clean-air city would show four green cards, so a broken
    // live feed would look indistinguishable from a pleasant day.
    expect(FALLBACK_LOCATION.name).toBe('Chennai');
  });
});
