/**
 * Live sensor feed tests.
 *
 * As with `use-environment.test.ts`, most of what matters is invisible on the happy path:
 *
 * 1. **Disabled means silent.** With the picker on "simulated" the hook must make no native
 *    call at all — a stray `getSdkStatus` on a phone without Health Connect is a crash.
 * 2. **Which paths may prompt.** Only `requestAccess` calls `requestVitalsAccess`. The
 *    interval and the foreground catch-up never do.
 * 3. **The read range.** Every poll — the warm-up and each later one — reads back the full
 *    retention window, never `(lastPolledAt, now]`. Companion apps (Fitbit, Samsung Health,
 *    Garmin…) write to Health Connect minutes after measurement with the *original* sample
 *    timestamps, so a delta range would never see a sample measured at T+3 and written at
 *    T+15. The ring buffer's dedupe absorbs the overlap.
 * 4. **Foreground catch-up at its boundary.** `>=` pinned on both sides.
 * 5. **Nothing after unmount.** A poll that resolves after the provider is gone must not touch
 *    state.
 * 6. **The store is the system of record (M6).** Every poll appends to it and reads the buffer
 *    back from it; enabling warm-starts from it; it is pruned to seven days; a disabled
 *    (simulated) feed never writes a byte; and a store failure degrades to the in-memory
 *    merge with `storeFailure` set, never to an empty Dashboard.
 *
 * The store here is a `MemoryReadingStore` — the contract is the same as SQLite's
 * (`src/store/__tests__/store-contract.ts`), and what this file asserts is *when* the hook
 * talks to it, not how the store works.
 */

import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { longestLookbackMs, resolveRiskThresholds, type SensorReading } from '@/risk';
import {
  checkHealthConnect,
  grantedVitalsPermissions,
  readVitals,
  requestVitalsAccess,
} from '@/sensors/health-connect';
import { isMotionAvailable, startMotionFold, type MotionFold } from '@/sensors/motion';
import {
  BUFFER_RETAIN_MS,
  POLL_INTERVAL_MS,
  useSensors,
  type UseSensorsOptions,
} from '@/hooks/use-sensors';
import { HISTORY_RETAIN_MS, MemoryReadingStore, ReadingStoreError } from '@/store';

jest.mock('@/sensors/health-connect', () => ({
  ...jest.requireActual('@/sensors/health-connect'),
  checkHealthConnect: jest.fn(),
  grantedVitalsPermissions: jest.fn(),
  requestVitalsAccess: jest.fn(),
  readVitals: jest.fn(),
}));

jest.mock('@/sensors/motion', () => ({
  ...jest.requireActual('@/sensors/motion'),
  isMotionAvailable: jest.fn(),
  startMotionFold: jest.fn(),
}));

const check = jest.mocked(checkHealthConnect);
const granted = jest.mocked(grantedVitalsPermissions);
const request = jest.mocked(requestVitalsAccess);
const read = jest.mocked(readVitals);
const motionAvailable = jest.mocked(isMotionAvailable);
const startFold = jest.mocked(startMotionFold);

const NOW = 1_766_000_000_000;
const STILL = { peakG: 1.02, minG: 0.98, rmsG: 1.0, sampleCount: 1500 };

let appStateHandlers: ((status: AppStateStatus) => void)[] = [];
let fold: { flush: jest.Mock; stop: jest.Mock };
/** Fresh per test. Spied on where a test is about *when* the hook writes, not what it stores. */
let store: MemoryReadingStore;

function hrAt(timestamp: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp, hr: bpm };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function emitAppState(status: AppStateStatus) {
  await act(async () => {
    for (const handler of appStateHandlers) handler(status);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  appStateHandlers = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    appStateHandlers.push(handler as (status: AppStateStatus) => void);
    return { remove: jest.fn() } as never;
  });

  fold = { flush: jest.fn(() => STILL), stop: jest.fn() };
  store = new MemoryReadingStore();
  check.mockReset().mockResolvedValue('available');
  granted.mockReset().mockResolvedValue(['HeartRate', 'OxygenSaturation', 'SkinTemperature']);
  request.mockReset().mockResolvedValue([]);
  read.mockReset().mockResolvedValue([]);
  motionAvailable.mockReset().mockResolvedValue(true);
  startFold.mockReset().mockReturnValue(fold as unknown as MotionFold);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('constants', () => {
  it('retains at least the engine lookback plus two poll intervals of headroom', () => {
    expect(BUFFER_RETAIN_MS).toBe(
      longestLookbackMs(resolveRiskThresholds()) + 2 * POLL_INTERVAL_MS,
    );
  });
});

describe('disabled', () => {
  it('is idle and never touches a native module', async () => {
    const { result } = await renderHook(() => useSensors({ enabled: false, store }));
    await settle();
    expect(result.current.status).toBe('idle');
    expect(result.current.readings).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    expect(startFold).not.toHaveBeenCalled();
  });
});

describe('availability and permissions', () => {
  it('reports unavailable with a reason and does not poll', async () => {
    check.mockResolvedValue('unavailable');
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.failure?.kind).toBe('sdk');
    expect(read).not.toHaveBeenCalled();
  });

  it('names an update requirement distinctly', async () => {
    check.mockResolvedValue('update-required');
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.failure?.message).toMatch(/update/i);
  });

  it('stops at permission-required without prompting when nothing is granted', async () => {
    granted.mockResolvedValue([]);
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(result.current.status).toBe('permission-required');
    expect(request).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('requestAccess prompts, then starts polling on a grant', async () => {
    granted.mockResolvedValue([]);
    request.mockResolvedValue(['HeartRate']);
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();

    await act(async () => {
      result.current.requestAccess();
    });
    await settle();

    expect(request).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({
      sinceMs: NOW - BUFFER_RETAIN_MS,
      untilMs: NOW,
      granted: ['HeartRate'],
    });
    expect(result.current.status).toBe('live');
  });

  it('stays at permission-required when the dialog grants nothing', async () => {
    granted.mockResolvedValue([]);
    request.mockResolvedValue([]);
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    await act(async () => {
      result.current.requestAccess();
    });
    await settle();
    expect(result.current.status).toBe('permission-required');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('polling', () => {
  it('warms up over the full lookback, then attaches the motion summary at the poll instant', async () => {
    read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();

    expect(read).toHaveBeenCalledWith({
      sinceMs: NOW - BUFFER_RETAIN_MS,
      untilMs: NOW,
      granted: ['HeartRate', 'OxygenSaturation', 'SkinTemperature'],
    });
    expect(startFold).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('live');
    expect(result.current.lastPolledAt).toBe(NOW);
    expect(result.current.readings).toEqual([
      hrAt(NOW - 30_000, 72),
      { source: 'health_connect', timestamp: NOW, motionSummary: STILL },
    ]);
  });

  it('emits a motion-only reading when Health Connect returned nothing', async () => {
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(result.current.readings).toEqual([
      { source: 'health_connect', timestamp: NOW, motionSummary: STILL },
    ]);
  });

  it('omits motion when the accelerometer is unavailable', async () => {
    motionAvailable.mockResolvedValue(false);
    read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(startFold).not.toHaveBeenCalled();
    expect(result.current.readings).toEqual([hrAt(NOW - 30_000, 72)]);
  });

  it('polls the full retention window every interval and never prompts', async () => {
    // Not `(lastPolledAt, now]`: a band that syncs in batches writes samples stamped minutes
    // before the write, and a delta range would miss every one of them after the warm-up.
    await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    read.mockClear();

    await advance(POLL_INTERVAL_MS);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({
      sinceMs: NOW + POLL_INTERVAL_MS - BUFFER_RETAIN_MS,
      untilMs: NOW + POLL_INTERVAL_MS,
      granted: ['HeartRate', 'OxygenSaturation', 'SkinTemperature'],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the buffer and reports a read failure', async () => {
    read.mockResolvedValueOnce([hrAt(NOW - 30_000, 72)]);
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();

    read.mockRejectedValueOnce(new Error('Health Connect busy'));
    await advance(POLL_INTERVAL_MS);

    expect(result.current.status).toBe('error');
    expect(result.current.failure).toEqual({ kind: 'read', message: 'Health Connect busy' });
    expect(result.current.readings.some((r) => r.hr === 72)).toBe(true);
    // A failed poll does not count as one: `lastPolledAt` stays at the last success.
    expect(result.current.lastPolledAt).toBe(NOW);
  });

  it('still emits the motion reading on a failed vitals read, so fall detection survives a flaky band', async () => {
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    read.mockRejectedValueOnce(new Error('busy'));
    await advance(POLL_INTERVAL_MS);
    expect(
      result.current.readings.filter((r) => r.motionSummary !== undefined).map((r) => r.timestamp),
    ).toEqual([NOW, NOW + POLL_INTERVAL_MS]);
  });
});

describe('foreground catch-up', () => {
  it('does not poll when the app returns before an interval has elapsed', async () => {
    await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    read.mockClear();

    jest.setSystemTime(NOW + POLL_INTERVAL_MS - 1);
    await emitAppState('active');

    expect(read).not.toHaveBeenCalled();
  });

  it('polls immediately when the app returns after an interval has elapsed', async () => {
    await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    read.mockClear();

    jest.setSystemTime(NOW + POLL_INTERVAL_MS);
    await emitAppState('active');
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('ignores non-active transitions', async () => {
    await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    read.mockClear();
    jest.setSystemTime(NOW + 2 * POLL_INTERVAL_MS);
    await emitAppState('background');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('stops the fold and clears the buffer when disabled', async () => {
    const { result, rerender } = await renderHook(({ enabled }: Pick<UseSensorsOptions, 'enabled'>) => useSensors({ enabled, store }), {
      initialProps: { enabled: true },
    });
    await settle();
    expect(result.current.status).toBe('live');

    await rerender({ enabled: false });
    await settle();

    expect(fold.stop).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('idle');
    expect(result.current.readings).toEqual([]);
  });

  it('ignores a poll that resolves after unmount', async () => {
    const pending = deferred<SensorReading[]>();
    read.mockReturnValue(pending.promise);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(result.current.status).toBe('loading');

    await unmount();
    await act(async () => {
      pending.resolve([hrAt(NOW - 1000, 70)]);
      await Promise.resolve();
    });

    expect(fold.stop).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('re-enabling while an old poll is still in flight starts a fresh warm-up poll', async () => {
    // A boolean "polling" latch would see the superseded read as still in flight and skip the
    // new generation's first poll, leaving the feed at "loading" until the next interval tick.
    const stale = deferred<SensorReading[]>();
    read.mockReturnValueOnce(stale.promise);
    const { result, rerender } = await renderHook(({ enabled }: Pick<UseSensorsOptions, 'enabled'>) => useSensors({ enabled, store }), {
      initialProps: { enabled: true },
    });
    await settle();
    expect(read).toHaveBeenCalledTimes(1);

    await rerender({ enabled: false });
    await settle();
    read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
    await rerender({ enabled: true });
    await settle();

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('live');
    expect(result.current.readings.some((r) => r.hr === 72)).toBe(true);

    // The superseded read landing late must not disturb the new generation.
    await act(async () => {
      stale.resolve([hrAt(NOW - 5000, 99)]);
      await Promise.resolve();
    });
    expect(result.current.readings.some((r) => r.hr === 99)).toBe(false);
  });

  it('starts a single accelerometer fold when requestAccess overlaps the initial permission check', async () => {
    // `ready` is set before the silent grant check is awaited, so a tap in that window makes
    // two `beginPolling` calls race through `isMotionAvailable`; only one may own the fold.
    const grantCheck = deferred<('HeartRate' | 'OxygenSaturation' | 'SkinTemperature')[]>();
    granted.mockReturnValue(grantCheck.promise);
    const motionCheck = deferred<boolean>();
    motionAvailable.mockReturnValue(motionCheck.promise);
    request.mockResolvedValue(['HeartRate']);

    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    await act(async () => {
      result.current.requestAccess();
    });
    await act(async () => {
      grantCheck.resolve(['HeartRate']);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      motionCheck.resolve(true);
    });
    await settle();

    expect(startFold).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('live');
  });
});

describe('reading store (M6)', () => {
  it('retains seven days of history in the store', () => {
    expect(HISTORY_RETAIN_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(HISTORY_RETAIN_MS).toBeGreaterThan(BUFFER_RETAIN_MS);
  });

  it('warm-starts the buffer from the store before the first poll resolves', async () => {
    // A restart used to mean an empty buffer until Health Connect answered; now the previous
    // session's readings are on screen while the first read is still in flight.
    await store.append([hrAt(NOW - 5 * 60_000, 68), hrAt(NOW - HISTORY_RETAIN_MS + 1, 50)]);
    const pending = deferred<SensorReading[]>();
    read.mockReturnValue(pending.promise);

    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();

    expect(result.current.status).toBe('loading');
    // Only the engine window, not the whole seven days: the feed's buffer is what the engine
    // scores, and the fixture's old reading is history for Trends, not for the Dashboard.
    expect(result.current.readings).toEqual([hrAt(NOW - 5 * 60_000, 68)]);
  });

  it('does not warm-start while permissions are missing', async () => {
    await store.append([hrAt(NOW - 60_000, 68)]);
    granted.mockResolvedValue([]);
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(result.current.status).toBe('permission-required');
    expect(result.current.readings).toEqual([]);
  });

  it('appends each poll (vitals and motion) then serves the buffer from the store', async () => {
    const append = jest.spyOn(store, 'append');
    const readSince = jest.spyOn(store, 'readSince');
    read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);

    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();

    const motionAtNow = { source: 'health_connect', timestamp: NOW, motionSummary: STILL };
    expect(append).toHaveBeenCalledWith([hrAt(NOW - 30_000, 72), motionAtNow]);
    // The poll's `readSince` comes after its `append`, over the engine window.
    expect(readSince).toHaveBeenLastCalledWith(NOW - BUFFER_RETAIN_MS);
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(readSince.mock.invocationCallOrder.at(-1)!);
    await expect(store.count()).resolves.toBe(2);
    expect(result.current.readings).toEqual([hrAt(NOW - 30_000, 72), motionAtNow]);
    expect(result.current.storeFailure).toBeNull();
  });

  it('persists the motion-only reading of a failed vitals read', async () => {
    // The fall rule needs the motion trail even when the band is flaky, and a restart in the
    // middle of a flaky patch must not lose it.
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    read.mockRejectedValueOnce(new Error('busy'));
    await advance(POLL_INTERVAL_MS);

    const stored = await store.readSince(0);
    expect(stored.filter((r) => r.motionSummary !== undefined).map((r) => r.timestamp)).toEqual([
      NOW,
      NOW + POLL_INTERVAL_MS,
    ]);
    expect(result.current.status).toBe('error');
    expect(result.current.failure?.kind).toBe('read');
  });

  it('serves readings the store holds that this session never polled', async () => {
    // What "system of record" means: a later poll's buffer includes what an earlier session
    // stored, not only what `mergeReadings` saw in memory.
    await store.append([hrAt(NOW - 2 * 60_000, 64)]);
    read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
    const { result } = await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(result.current.readings.map((r) => r.hr)).toEqual([64, 72, undefined]);
  });

  it('prunes the store to the seven-day cutoff once per poll', async () => {
    const prune = jest.spyOn(store, 'prune');
    await store.append([hrAt(NOW - HISTORY_RETAIN_MS - 1, 40), hrAt(NOW - HISTORY_RETAIN_MS, 41)]);

    await renderHook(() => useSensors({ enabled: true, store }));
    await settle();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(prune).toHaveBeenCalledWith(NOW - HISTORY_RETAIN_MS);
    // Strictly older is gone; exactly seven days old is kept.
    expect((await store.readSince(0)).map((r) => r.hr)).toEqual([41, undefined]);

    await advance(POLL_INTERVAL_MS);
    expect(prune).toHaveBeenCalledTimes(2);
    expect(prune).toHaveBeenLastCalledWith(NOW + POLL_INTERVAL_MS - HISTORY_RETAIN_MS);
  });

  it('never writes to the store while disabled — simulated readings are not history', async () => {
    const append = jest.spyOn(store, 'append');
    const prune = jest.spyOn(store, 'prune');
    const clear = jest.spyOn(store, 'clear');

    const { result } = await renderHook(() => useSensors({ enabled: false, store }));
    await settle();
    await advance(3 * POLL_INTERVAL_MS);
    await emitAppState('active');
    await act(async () => {
      result.current.refresh();
      result.current.requestAccess();
    });
    await settle();

    expect(append).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    await expect(store.count()).resolves.toBe(0);
  });

  it('does not write on the disable cleanup either', async () => {
    const { rerender } = await renderHook(({ enabled }: Pick<UseSensorsOptions, 'enabled'>) => useSensors({ enabled, store }), {
      initialProps: { enabled: true },
    });
    await settle();
    const append = jest.spyOn(store, 'append');
    await rerender({ enabled: false });
    await settle();
    await advance(2 * POLL_INTERVAL_MS);
    expect(append).not.toHaveBeenCalled();
  });

  describe('store failure', () => {
    it('keeps the in-memory buffer, keeps polling, and reports storeFailure when append throws', async () => {
      read.mockResolvedValueOnce([hrAt(NOW - 30_000, 72)]);
      const { result } = await renderHook(() => useSensors({ enabled: true, store }));
      await settle();
      expect(result.current.readings.some((r) => r.hr === 72)).toBe(true);

      jest
        .spyOn(store, 'append')
        .mockRejectedValue(new ReadingStoreError('append', new Error('database or disk is full')));
      read.mockResolvedValueOnce([hrAt(NOW + POLL_INTERVAL_MS - 30_000, 75)]);
      await advance(POLL_INTERVAL_MS);

      // Both polls' readings are on screen — the merge fallback, not an empty store read.
      expect(result.current.readings.map((r) => r.hr)).toEqual([72, undefined, 75, undefined]);
      expect(result.current.status).toBe('live');
      expect(result.current.failure).toBeNull();
      expect(result.current.storeFailure).toEqual({
        kind: 'store',
        message: 'Reading store append failed: database or disk is full',
      });
      expect(result.current.lastPolledAt).toBe(NOW + POLL_INTERVAL_MS);

      // Still polling afterwards.
      read.mockClear();
      await advance(POLL_INTERVAL_MS);
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('clears storeFailure once a later poll persists again', async () => {
      const append = jest.spyOn(store, 'append');
      append.mockRejectedValueOnce(new ReadingStoreError('append', new Error('locked')));
      const { result } = await renderHook(() => useSensors({ enabled: true, store }));
      await settle();
      expect(result.current.storeFailure?.kind).toBe('store');

      await advance(POLL_INTERVAL_MS);
      expect(result.current.storeFailure).toBeNull();
      await expect(store.count()).resolves.toBeGreaterThan(0);
    });

    it('falls back to the merge when readSince throws after a successful append', async () => {
      read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
      jest.spyOn(store, 'readSince').mockRejectedValue(new ReadingStoreError('readSince', new Error('io')));
      const { result } = await renderHook(() => useSensors({ enabled: true, store }));
      await settle();
      expect(result.current.readings.map((r) => r.hr)).toEqual([72, undefined]);
      expect(result.current.storeFailure?.kind).toBe('store');
      // The append itself went through.
      await expect(store.count()).resolves.toBe(2);
    });

    it('starts empty, without failing the feed, when the warm start throws', async () => {
      jest.spyOn(store, 'readSince').mockRejectedValueOnce(new ReadingStoreError('readSince', new Error('io')));
      read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
      const { result } = await renderHook(() => useSensors({ enabled: true, store }));
      await settle();
      expect(result.current.status).toBe('live');
      expect(result.current.readings.some((r) => r.hr === 72)).toBe(true);
    });

    it('resets storeFailure on disable', async () => {
      jest.spyOn(store, 'append').mockRejectedValue(new ReadingStoreError('append', new Error('x')));
      const { result, rerender } = await renderHook(
        ({ enabled }: Pick<UseSensorsOptions, 'enabled'>) => useSensors({ enabled, store }),
        { initialProps: { enabled: true } },
      );
      await settle();
      expect(result.current.storeFailure).not.toBeNull();
      await rerender({ enabled: false });
      await settle();
      expect(result.current.storeFailure).toBeNull();
    });
  });
});
