/**
 * Environment feed tests.
 *
 * This hook is the only thing standing between a failed network call and an empty health
 * screen, so most of what is asserted here is about *degradation* rather than the happy
 * path — and three of the properties are ones a passing app would hide:
 *
 * 1. **Cache before network.** A cold launch on a train has to render the last known good
 *    reading, not a spinner that never resolves. So the cached value is asserted to be on
 *    screen *while the fetch is still in flight*, which is the only window in which the
 *    difference is observable.
 * 2. **Which prompts are allowed.** A location dialog appearing unbidden 30 minutes in,
 *    while the user is on another screen, is how a permission gets permanently denied. The
 *    background paths are asserted to pass `canPrompt: false` and the user-initiated ones
 *    `true` — a distinction with no visible symptom until it has already cost the permission.
 * 3. **The foreground catch-up, at its exact boundary.** React Native suspends JS timers
 *    while backgrounded, so the 30-minute interval alone does not deliver a 30-minute
 *    promise. The `>=` comparison that closes that gap is pinned on both sides, because a
 *    refresh-on-every-app-switch and a never-refresh are both one operator away and neither
 *    announces itself.
 */

import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import {
  EnvironmentError,
  fetchLiveEnvironment,
  readCachedEnvironment,
  type LiveEnvironment,
} from '@/environment';
import { liveEnvironment } from '@/environment/__tests__/fixtures';
import { REFRESH_INTERVAL_MS, useEnvironment } from '@/hooks/use-environment';

// Hoisted above the imports, so the two entry points below are already the mocked copies.
// The rest of the module stays real: `EnvironmentError` has to be the same class the hook
// tests `instanceof` against, or every failure would be reported as `unknown`.
jest.mock('@/environment', () => ({
  ...jest.requireActual('@/environment'),
  fetchLiveEnvironment: jest.fn(),
  readCachedEnvironment: jest.fn(),
}));

const mockedFetch = fetchLiveEnvironment as jest.MockedFunction<typeof fetchLiveEnvironment>;
const mockedRead = readCachedEnvironment as jest.MockedFunction<typeof readCachedEnvironment>;

const NOW = 1_766_000_000_000;

const LIVE = liveEnvironment({ location: 'Chennai', fetchedAt: NOW, tempC: 38 });
const CACHED = liveEnvironment({ location: 'Chennai', fetchedAt: NOW - 60 * 60 * 1000, tempC: 31 });

let appStateHandlers: ((status: AppStateStatus) => void)[] = [];

/** A promise this test resolves by hand, so "in flight" is an observable state. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function emitAppState(status: AppStateStatus) {
  await act(async () => {
    for (const handler of appStateHandlers) handler(status);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** Let already-resolved promises inside the effect chain settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  mockedFetch.mockReset();
  mockedRead.mockReset();
  mockedRead.mockResolvedValue(null);

  appStateHandlers = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'change') appStateHandlers.push(handler as (status: AppStateStatus) => void);
    return { remove: jest.fn() } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** The options object the hook passed on its Nth call. */
function callOptions(index: number) {
  return mockedFetch.mock.calls[index][0];
}

describe('the first load', () => {
  it('shows the cached reading while the network call is still in flight', async () => {
    mockedRead.mockResolvedValue(CACHED);
    const pending = deferred<LiveEnvironment>();
    mockedFetch.mockReturnValue(pending.promise);

    const { result } = await renderHook(() => useEnvironment());

    // The whole point of the cache: something true on screen before the network answers.
    expect(result.current.environment).toEqual(CACHED);
    expect(result.current.status).toBe('cached');
    expect(result.current.failure).toBeNull();

    await act(async () => {
      pending.resolve(LIVE);
    });

    expect(result.current.environment).toEqual(LIVE);
    expect(result.current.status).toBe('live');
  });

  it('reports loading, not error, when there is nothing cached yet', async () => {
    const pending = deferred<LiveEnvironment>();
    mockedFetch.mockReturnValue(pending.promise);

    const { result } = await renderHook(() => useEnvironment());

    expect(result.current.environment).toBeNull();
    expect(result.current.status).toBe('loading');

    await act(async () => {
      pending.resolve(LIVE);
    });

    expect(result.current.status).toBe('live');
  });

  it('reads the cache before it calls out, rather than after', async () => {
    mockedRead.mockResolvedValue(CACHED);
    mockedFetch.mockResolvedValue(LIVE);

    await renderHook(() => useEnvironment());

    // Ordering, not just presence: reading the cache after the fetch resolves would make
    // the cache useless on exactly the launch it exists for.
    expect(mockedRead).toHaveBeenCalled();
    expect(mockedRead.mock.invocationCallOrder[0]).toBeLessThan(
      mockedFetch.mock.invocationCallOrder[0],
    );
  });

  it('is allowed to raise the permission dialog, because the user just opened the app', async () => {
    mockedFetch.mockResolvedValue(LIVE);
    await renderHook(() => useEnvironment());

    expect(callOptions(0).canPrompt).toBe(true);
  });
});

describe('when the fetch fails', () => {
  it('falls back to the cached reading and says so', async () => {
    mockedRead.mockResolvedValue(CACHED);
    mockedFetch.mockRejectedValue(
      new EnvironmentError('Weather service is temporarily unavailable.', 'network'),
    );

    const { result } = await renderHook(() => useEnvironment());

    expect(result.current.status).toBe('cached');
    expect(result.current.environment).toEqual(CACHED);
    expect(result.current.failure).toEqual({
      message: 'Weather service is temporarily unavailable.',
      kind: 'network',
    });
  });

  it('reports an error when there is nothing cached to fall back to', async () => {
    mockedFetch.mockRejectedValue(new EnvironmentError('No weather API key configured.', 'config'));

    const { result } = await renderHook(() => useEnvironment());

    expect(result.current.status).toBe('error');
    expect(result.current.environment).toBeNull();
    expect(result.current.failure?.kind).toBe('config');
  });

  it('does not repeat an unexpected error’s own message to the user', async () => {
    // A raw throw from anywhere in the stack can carry a request URL, and the URL carries
    // the API key. Anything that is not an `EnvironmentError` gets a written message.
    mockedFetch.mockRejectedValue(
      new TypeError('Network request failed: GET https://api.openweathermap.org/x?appid=secret'),
    );

    const { result } = await renderHook(() => useEnvironment());

    expect(result.current.failure).toEqual({
      message: 'Could not update environment data.',
      kind: 'unknown',
    });
    expect(result.current.failure?.message).not.toContain('secret');
  });

  it('re-reads the cache rather than trusting its own state, which is null on a cold start', async () => {
    mockedRead.mockResolvedValue(CACHED);
    mockedFetch.mockRejectedValue(new EnvironmentError('down', 'network'));

    await renderHook(() => useEnvironment());

    // Once for the pre-paint, once for the fallback.
    expect(mockedRead).toHaveBeenCalledTimes(2);
  });

  it('keeps a reading already on screen instead of blanking it', async () => {
    mockedFetch.mockResolvedValueOnce(LIVE);
    const { result } = await renderHook(() => useEnvironment());
    expect(result.current.status).toBe('live');

    mockedRead.mockResolvedValue(CACHED);
    mockedFetch.mockRejectedValueOnce(new EnvironmentError('down', 'network'));
    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.environment).not.toBeNull();
    expect(result.current.status).toBe('cached');
  });

  it('clears the failure once a later attempt succeeds', async () => {
    mockedFetch.mockRejectedValueOnce(new EnvironmentError('down', 'network'));
    const { result } = await renderHook(() => useEnvironment());
    expect(result.current.failure).not.toBeNull();

    mockedFetch.mockResolvedValueOnce(LIVE);
    await act(async () => {
      result.current.refresh();
    });

    // A stale error banner over live data is its own kind of lie.
    expect(result.current.failure).toBeNull();
    expect(result.current.status).toBe('live');
  });
});

describe('the 30-minute refresh', () => {
  it('is 30 minutes, as PRD §7.2.3 specifies', () => {
    expect(REFRESH_INTERVAL_MS).toBe(30 * 60 * 1000);
  });

  it('fetches again on each interval', async () => {
    mockedFetch.mockResolvedValue(LIVE);
    await renderHook(() => useEnvironment());
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await advance(REFRESH_INTERVAL_MS);
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    await advance(REFRESH_INTERVAL_MS);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it('does not fetch early', async () => {
    mockedFetch.mockResolvedValue(LIVE);
    await renderHook(() => useEnvironment());

    await advance(REFRESH_INTERVAL_MS - 1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('never raises a permission dialog in the background', async () => {
    mockedFetch.mockResolvedValue(LIVE);
    await renderHook(() => useEnvironment());

    await advance(REFRESH_INTERVAL_MS);
    expect(callOptions(1).canPrompt).toBe(false);
  });

  it('stops after unmount', async () => {
    mockedFetch.mockResolvedValue(LIVE);
    const { unmount } = await renderHook(() => useEnvironment());
    await unmount();

    await advance(3 * REFRESH_INTERVAL_MS);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe('the on-demand refresh', () => {
  it('fetches immediately', async () => {
    mockedFetch.mockResolvedValue(LIVE);
    const { result } = await renderHook(() => useEnvironment());

    await act(async () => {
      result.current.refresh();
    });

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('may prompt, so a denied permission is recoverable by tapping refresh', async () => {
    mockedFetch.mockResolvedValue(LIVE);
    const { result } = await renderHook(() => useEnvironment());

    await act(async () => {
      result.current.refresh();
    });

    expect(callOptions(1).canPrompt).toBe(true);
  });

  it('reports itself in flight, so the button can disable and the screen can say so', async () => {
    mockedFetch.mockResolvedValueOnce(LIVE);
    const { result } = await renderHook(() => useEnvironment());
    expect(result.current.refreshing).toBe(false);

    const pending = deferred<LiveEnvironment>();
    mockedFetch.mockReturnValueOnce(pending.promise);
    await act(async () => {
      result.current.refresh();
    });
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      pending.resolve(LIVE);
    });
    expect(result.current.refreshing).toBe(false);
  });

  it('lands on false even when the attempt fails', async () => {
    mockedFetch.mockRejectedValue(new EnvironmentError('down', 'network'));
    const { result } = await renderHook(() => useEnvironment());

    // A spinner that never stops is worse than an error message.
    expect(result.current.refreshing).toBe(false);
  });

  it('keeps the current reading on screen while it runs', async () => {
    mockedFetch.mockResolvedValueOnce(LIVE);
    const { result } = await renderHook(() => useEnvironment());

    const pending = deferred<LiveEnvironment>();
    mockedFetch.mockReturnValueOnce(pending.promise);
    await act(async () => {
      result.current.refresh();
    });

    expect(result.current.environment).toEqual(LIVE);
    expect(result.current.status).toBe('live');
  });
});

describe('superseding an in-flight request', () => {
  it('aborts the older request when a newer one starts', async () => {
    const pending = deferred<LiveEnvironment>();
    mockedFetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(LIVE);

    const { result } = await renderHook(() => useEnvironment());
    const firstSignal = callOptions(0).signal;
    expect(firstSignal?.aborted).toBe(false);

    await act(async () => {
      result.current.refresh();
    });

    expect(firstSignal?.aborted).toBe(true);
  });

  it('aborts in-flight work on unmount', async () => {
    mockedFetch.mockReturnValue(deferred<LiveEnvironment>().promise);

    const { unmount } = await renderHook(() => useEnvironment());
    const signal = callOptions(0).signal;

    await unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('does not let a superseded response overwrite fresher data', async () => {
    const older = deferred<LiveEnvironment>();
    const newer = deferred<LiveEnvironment>();
    mockedFetch.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

    const { result } = await renderHook(() => useEnvironment());
    await act(async () => {
      result.current.refresh();
    });

    const newest = liveEnvironment({ location: 'Newer', tempC: 41 });
    await act(async () => {
      newer.resolve(newest);
    });
    // The slow first request finally answers, with data that is now out of date.
    await act(async () => {
      older.resolve(liveEnvironment({ location: 'Older', tempC: 20 }));
    });

    expect(result.current.environment?.location).toBe('Newer');
  });

  it('does not touch state after unmount', async () => {
    const pending = deferred<LiveEnvironment>();
    mockedFetch.mockReturnValue(pending.promise);

    const { unmount } = await renderHook(() => useEnvironment());
    expect(mockedRead).toHaveBeenCalledTimes(1);

    await unmount();
    await act(async () => {
      pending.reject(new EnvironmentError('down', 'network'));
      await Promise.resolve();
    });

    // Observable proxy for "no setState after unmount": the failure path checks `mounted`
    // *before* consulting the cache, so a second read would mean the guard did not hold.
    expect(mockedRead).toHaveBeenCalledTimes(1);
  });
});

describe('catching up when the app comes back to the foreground', () => {
  /** Mount with a successful load whose observation was fetched `ageMs` ago. */
  async function mountWithAge(ageMs: number) {
    mockedFetch.mockResolvedValue(liveEnvironment({ fetchedAt: NOW - ageMs }));
    const rendered = await renderHook(() => useEnvironment());
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    return rendered;
  }

  it('refreshes when the data on screen is already older than the interval', async () => {
    // The case the interval cannot cover: the platform suspended the timer while the phone
    // was in a pocket, so no tick ever landed.
    await mountWithAge(REFRESH_INTERVAL_MS);

    await emitAppState('active');
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(callOptions(1).canPrompt).toBe(false);
  });

  it('leaves fresh data alone, so app switching is not a request per switch', async () => {
    await mountWithAge(REFRESH_INTERVAL_MS - 1);

    await emitAppState('active');
    await emitAppState('active');
    await emitAppState('active');

    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('refreshes when nothing has ever loaded', async () => {
    mockedFetch.mockRejectedValue(new EnvironmentError('down', 'network'));
    await renderHook(() => useEnvironment());
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await emitAppState('active');
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('ignores transitions other than becoming active', async () => {
    await mountWithAge(REFRESH_INTERVAL_MS);

    await emitAppState('background');
    await emitAppState('inactive');

    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('counts the age from the cached entry too, not only from a live fetch', async () => {
    // On an offline launch the only thing on screen came from disk, and its age is what
    // decides whether coming back to the app is worth another attempt.
    mockedRead.mockResolvedValue(liveEnvironment({ fetchedAt: NOW - REFRESH_INTERVAL_MS }));
    mockedFetch.mockRejectedValue(new EnvironmentError('down', 'network'));

    const { result } = await renderHook(() => useEnvironment());
    expect(result.current.status).toBe('cached');

    await emitAppState('active');
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('does not re-subscribe on every data change', async () => {
    mockedFetch.mockResolvedValue(LIVE);
    const { result } = await renderHook(() => useEnvironment());
    const subscriptions = appStateHandlers.length;

    await act(async () => {
      result.current.refresh();
    });
    await settle();

    // The listener depends only on `load`, which is stable; mirroring `fetchedAt` in a ref
    // is what keeps this effect from tearing down and re-arming on every response.
    expect(appStateHandlers).toHaveLength(subscriptions);
  });
});
