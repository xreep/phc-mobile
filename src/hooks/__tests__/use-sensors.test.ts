/**
 * Live sensor feed tests.
 *
 * As with `use-environment.test.ts`, most of what matters is invisible on the happy path:
 *
 * 1. **Disabled means silent.** With the picker on "simulated" the hook must make no native
 *    call at all — a stray `getSdkStatus` on a phone without Health Connect is a crash.
 * 2. **Which paths may prompt.** Only `requestAccess` calls `requestVitalsAccess`. The
 *    interval and the foreground catch-up never do.
 * 3. **The warm-up range.** The first poll reads back the engine's full lookback so the
 *    extended rules see history immediately; later polls read from the last poll.
 * 4. **Foreground catch-up at its boundary.** `>=` pinned on both sides.
 * 5. **Nothing after unmount.** A poll that resolves after the provider is gone must not touch
 *    state.
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
    const { result } = await renderHook(() => useSensors({ enabled: false }));
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
    const { result } = await renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.failure?.kind).toBe('sdk');
    expect(read).not.toHaveBeenCalled();
  });

  it('names an update requirement distinctly', async () => {
    check.mockResolvedValue('update-required');
    const { result } = await renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.status).toBe('unavailable');
    expect(result.current.failure?.message).toMatch(/update/i);
  });

  it('stops at permission-required without prompting when nothing is granted', async () => {
    granted.mockResolvedValue([]);
    const { result } = await renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.status).toBe('permission-required');
    expect(request).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('requestAccess prompts, then starts polling on a grant', async () => {
    granted.mockResolvedValue([]);
    request.mockResolvedValue(['HeartRate']);
    const { result } = await renderHook(() => useSensors({ enabled: true }));
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
    const { result } = await renderHook(() => useSensors({ enabled: true }));
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
    const { result } = await renderHook(() => useSensors({ enabled: true }));
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
    const { result } = await renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(result.current.readings).toEqual([
      { source: 'health_connect', timestamp: NOW, motionSummary: STILL },
    ]);
  });

  it('omits motion when the accelerometer is unavailable', async () => {
    motionAvailable.mockResolvedValue(false);
    read.mockResolvedValue([hrAt(NOW - 30_000, 72)]);
    const { result } = await renderHook(() => useSensors({ enabled: true }));
    await settle();
    expect(startFold).not.toHaveBeenCalled();
    expect(result.current.readings).toEqual([hrAt(NOW - 30_000, 72)]);
  });

  it('polls every interval from the previous poll instant and never prompts', async () => {
    await renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockClear();

    await advance(POLL_INTERVAL_MS);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({
      sinceMs: NOW,
      untilMs: NOW + POLL_INTERVAL_MS,
      granted: ['HeartRate', 'OxygenSaturation', 'SkinTemperature'],
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps the buffer and reports a read failure', async () => {
    read.mockResolvedValueOnce([hrAt(NOW - 30_000, 72)]);
    const { result } = await renderHook(() => useSensors({ enabled: true }));
    await settle();

    read.mockRejectedValueOnce(new Error('Health Connect busy'));
    await advance(POLL_INTERVAL_MS);

    expect(result.current.status).toBe('error');
    expect(result.current.failure).toEqual({ kind: 'read', message: 'Health Connect busy' });
    expect(result.current.readings.some((r) => r.hr === 72)).toBe(true);
    // The failed range is not marked as polled, so the next tick re-reads it.
    expect(result.current.lastPolledAt).toBe(NOW);
  });

  it('still emits the motion reading on a failed vitals read, so fall detection survives a flaky band', async () => {
    const { result } = await renderHook(() => useSensors({ enabled: true }));
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
    await renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockClear();

    jest.setSystemTime(NOW + POLL_INTERVAL_MS - 1);
    await emitAppState('active');

    expect(read).not.toHaveBeenCalled();
  });

  it('polls immediately when the app returns after an interval has elapsed', async () => {
    await renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockClear();

    jest.setSystemTime(NOW + POLL_INTERVAL_MS);
    await emitAppState('active');
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });

  it('ignores non-active transitions', async () => {
    await renderHook(() => useSensors({ enabled: true }));
    await settle();
    read.mockClear();
    jest.setSystemTime(NOW + 2 * POLL_INTERVAL_MS);
    await emitAppState('background');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('stops the fold and clears the buffer when disabled', async () => {
    const { result, rerender } = await renderHook(({ enabled }: UseSensorsOptions) => useSensors({ enabled }), {
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

    const { result, unmount } = await renderHook(() => useSensors({ enabled: true }));
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
    const { result, rerender } = await renderHook(({ enabled }: UseSensorsOptions) => useSensors({ enabled }), {
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

    const { result } = await renderHook(() => useSensors({ enabled: true }));
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
