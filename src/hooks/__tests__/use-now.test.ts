/**
 * Ticking-clock tests.
 *
 * Two of these are load-bearing rather than routine, and both guard the same failure: a
 * clock that stops without saying so, while every label computed from it keeps rendering a
 * confident number.
 *
 * - **The tick.** Without it, `formatAge(now - observedAt)` is correct for one frame and
 *   then frozen. The environment feed refreshes every 30 minutes, so "Updated 2 min ago"
 *   would be displayed for half an hour, and the risk engine's `env.maxStaleMs` bound could
 *   never be crossed because `now - observedAt` would be a constant.
 * - **The foreground re-read.** React Native throttles and suspends JS timers while
 *   backgrounded, so the ticks do not accumulate in a pocket. The test for that advances the
 *   system clock *without* running timers, which is exactly the state a phone comes back in.
 */

import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { useNow } from '@/hooks/use-now';

const NOW = 1_766_000_000_000;
const TICK_MS = 30_000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

let appStateHandlers: ((status: AppStateStatus) => void)[] = [];
const removeSubscription = jest.fn();

/** Deliver an AppState transition to whatever the hook subscribed with. */
async function emitAppState(status: AppStateStatus) {
  await act(async () => {
    for (const handler of appStateHandlers) handler(status);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);

  appStateHandlers = [];
  removeSubscription.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'change') appStateHandlers.push(handler as (status: AppStateStatus) => void);
    return { remove: removeSubscription } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/** Let the fake clock and the interval advance together, the way real time does. */
async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

describe('useNow', () => {
  it('starts at the current instant', async () => {
    const { result } = await renderHook(() => useNow(TICK_MS));
    expect(result.current).toBe(NOW);
  });

  it('advances once the interval elapses', async () => {
    const { result } = await renderHook(() => useNow(TICK_MS));

    await advance(TICK_MS);
    expect(result.current).toBe(NOW + TICK_MS);
  });

  it('holds still until the interval actually elapses', async () => {
    const { result } = await renderHook(() => useNow(TICK_MS));

    await advance(TICK_MS - 1);
    expect(result.current).toBe(NOW);
  });

  it('keeps advancing rather than ticking once', async () => {
    // A one-shot timeout mistaken for an interval passes the previous test and then stops,
    // which is the frozen-clock bug wearing a working test as cover.
    const { result } = await renderHook(() => useNow(TICK_MS));

    await advance(3 * TICK_MS);
    expect(result.current).toBe(NOW + 3 * TICK_MS);
  });

  it('re-reads the clock when the app returns to the foreground', async () => {
    const { result } = await renderHook(() => useNow(TICK_MS));

    // The system clock moves while the timers do not: two hours in a pocket, with the JS
    // interval suspended by the platform. Nothing here advances timers.
    jest.setSystemTime(NOW + TWO_HOURS_MS);
    expect(result.current).toBe(NOW);

    await emitAppState('active');
    expect(result.current).toBe(NOW + TWO_HOURS_MS);
  });

  it('ignores transitions other than becoming active', async () => {
    const { result } = await renderHook(() => useNow(TICK_MS));

    jest.setSystemTime(NOW + TWO_HOURS_MS);
    await emitAppState('background');
    await emitAppState('inactive');

    expect(result.current).toBe(NOW);
  });

  it('stops its interval on unmount', async () => {
    // Identified by its period rather than by counting live timers: React Native's own
    // internals schedule several during a render, so a total count proves nothing.
    const scheduled = jest.spyOn(globalThis, 'setInterval');
    const cleared = jest.spyOn(globalThis, 'clearInterval');

    const { unmount } = await renderHook(() => useNow(TICK_MS));

    const index = scheduled.mock.calls.findIndex((call) => call[1] === TICK_MS);
    expect(index).toBeGreaterThanOrEqual(0);
    const timerId = scheduled.mock.results[index].value;

    await unmount();
    // A surviving interval calls `setNow` on an unmounted component every tick, forever.
    expect(cleared).toHaveBeenCalledWith(timerId);
  });

  it('removes its AppState subscription on unmount', async () => {
    const { unmount } = await renderHook(() => useNow(TICK_MS));
    await unmount();
    expect(removeSubscription).toHaveBeenCalledTimes(1);
  });

  it('re-arms on the new interval when the cadence changes', async () => {
    const { result, rerender } = await renderHook((props: { intervalMs: number }) => useNow(props.intervalMs), {
      initialProps: { intervalMs: TICK_MS },
    });

    await rerender({ intervalMs: 5 * TICK_MS });

    // The old, faster interval must be gone rather than running alongside the new one.
    await advance(TICK_MS);
    expect(result.current).toBe(NOW);

    await advance(4 * TICK_MS);
    expect(result.current).toBe(NOW + 5 * TICK_MS);
  });
});
