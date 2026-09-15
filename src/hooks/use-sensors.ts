/**
 * The live sensor feed as React state: Health Connect vitals plus the folded phone
 * accelerometer, polled every minute into a ring buffer sized from the engine's own lookback
 * (PRD §7.2.1).
 *
 * ## Same discipline as `use-environment.ts`
 * A `mounted` ref guards every `setState` after an `await`; the `AppState` listener closes the
 * gap React Native's suspended timers leave when the app is backgrounded; and the only path
 * allowed to raise a permission dialog is the user-initiated `requestAccess`. The reasons are
 * spelled out there and are not repeated here.
 *
 * ## Why there is no cache-first path
 * The environment feed paints a cached observation before fetching because a two-hour-old
 * temperature is still useful. A two-hour-old heart rate is not: the engine would score it
 * `stale` and decline to judge, so there is nothing true to show before the first poll. The
 * Dashboard says "waiting" instead (`SensorFeedNotice`).
 *
 * ## Generation counter, not AbortController
 * `readRecords` cannot be aborted. Each (re)start bumps `generation`, and any async step
 * whose captured generation no longer matches simply returns — the same "a newer request
 * supersedes an older one" rule the environment hook expresses with `abort()`.
 *
 * ## Every poll reads the full retention window, not a delta
 * Companion apps (Fitbit, Samsung Health, Garmin…) write to Health Connect minutes after
 * measurement, stamped with the *original* sample time. A sample measured at T+3 min and
 * written at T+15 is never inside a later `[lastPolledAt, now)` range, so a delta poll would
 * find data only on the warm-up read. Reading `now − BUFFER_RETAIN_MS → now` every time costs
 * nothing (the ~20-min window is far inside one `readRecords` page) and `mergeReadings`'
 * dedupe absorbs the overlap. `lastPolledAt` is kept for the AppState catch-up and the feed's
 * own freshness, never to bound a read.
 *
 * ## The motion reading is stamped at the poll instant and appended last
 * `rules/fall.ts` reads the trailing still run from the *newest* reading. Health Connect
 * samples are all `≤ now` (the read range ends at `now`), so a motion reading at exactly
 * `now`, appended after the vitals, is always newest — `mergeReadings` keeps insertion order
 * at equal timestamps for this reason.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { longestLookbackMs, resolveRiskThresholds, type SensorReading } from '@/risk';
import {
  checkHealthConnect,
  grantedVitalsPermissions,
  HEALTH_CONNECT_SOURCE,
  readVitals,
  requestVitalsAccess,
  type VitalsRecordType,
} from '@/sensors/health-connect';
import { isMotionAvailable, startMotionFold, type MotionFold } from '@/sensors/motion';
import { mergeReadings } from '@/sensors/ring-buffer';
import type { SensorFailure, SensorFailureKind, SensorFeed, SensorFeedStatus } from '@/sensors/types';

/**
 * PRD §7.2.1: "polling every 30–60 s for Health Connect". The upper end, because the engine's
 * duration rules were tuned and tested at 60 s (`mock-sensor-window.ts` documents the boundary
 * a faster cadence would move).
 */
export const POLL_INTERVAL_MS = 60 * 1000;

/**
 * `RiskAssessmentInput.readings` requires the buffer to span the engine's longest lookback.
 * Two intervals of headroom cover a poll that lands late plus the half-open window epsilon.
 */
export const BUFFER_RETAIN_MS = longestLookbackMs(resolveRiskThresholds()) + 2 * POLL_INTERVAL_MS;

export type UseSensorsOptions = {
  /** False when Settings has a source other than Health Connect selected. No native calls. */
  readonly enabled: boolean;
};

function describeFailure(error: unknown, kind: SensorFailureKind): SensorFailure {
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'Could not read from Health Connect.';
  return { message, kind };
}

export function useSensors({ enabled }: UseSensorsOptions): SensorFeed {
  const [readings, setReadings] = useState<readonly SensorReading[]>([]);
  const [status, setStatus] = useState<SensorFeedStatus>('idle');
  const [failure, setFailure] = useState<SensorFailure | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<number | null>(null);

  const mounted = useRef(true);
  const generation = useRef(0);
  /** Set once `checkHealthConnect` said available; `requestAccess` is a no-op before that. */
  const ready = useRef(false);
  /** Set once permissions exist; the interval and AppState paths poll only while true. */
  const active = useRef(false);
  /**
   * The generation whose poll is in flight, so a superseded read (disable → enable while
   * `readVitals` is pending) cannot block the new generation's first poll; its result is
   * dropped by `isCurrent` anyway.
   */
  const polling = useRef<number | null>(null);
  const granted = useRef<readonly VitalsRecordType[]>([]);
  const fold = useRef<MotionFold | null>(null);
  /** Mirrors `lastPolledAt` for the AppState check, which must not re-subscribe on change. */
  const lastPolledRef = useRef<number | null>(null);

  const isCurrent = useCallback((gen: number) => mounted.current && gen === generation.current, []);

  const poll = useCallback(async () => {
    const gen = generation.current;
    if (!active.current || polling.current === gen) return;
    polling.current = gen;

    const now = Date.now();
    const since = now - BUFFER_RETAIN_MS;

    // Flushed before the await so the summary spans exactly this interval, and emitted even if
    // the vitals read fails — a flaky band must not blind fall detection.
    const motion = fold.current?.flush() ?? null;
    const motionReading: SensorReading | null =
      motion === null ? null : { source: HEALTH_CONNECT_SOURCE, timestamp: now, motionSummary: motion };

    try {
      const vitals = await readVitals({ sinceMs: since, untilMs: now, granted: granted.current });
      if (!isCurrent(gen)) return;
      const incoming = motionReading === null ? vitals : [...vitals, motionReading];
      lastPolledRef.current = now;
      setLastPolledAt(now);
      setReadings((prev) => mergeReadings(prev, incoming, { now, retainMs: BUFFER_RETAIN_MS }));
      setStatus('live');
      setFailure(null);
    } catch (error) {
      if (!isCurrent(gen)) return;
      if (motionReading !== null) {
        setReadings((prev) =>
          mergeReadings(prev, [motionReading], { now, retainMs: BUFFER_RETAIN_MS }),
        );
      }
      setStatus('error');
      setFailure(describeFailure(error, 'read'));
    } finally {
      if (polling.current === gen) polling.current = null;
    }
  }, [isCurrent]);

  /** Permissions exist: start the accelerometer fold (once) and take the first poll. */
  const beginPolling = useCallback(
    async (gen: number) => {
      if (fold.current === null) {
        const available = await isMotionAvailable();
        if (!isCurrent(gen)) return;
        // Re-checked after the await: `requestAccess` during the initial grant check runs a
        // second `beginPolling` through here, and only one may own the accelerometer.
        if (available && fold.current === null) fold.current = startMotionFold();
      }
      active.current = true;
      await poll();
    },
    [isCurrent, poll],
  );

  const start = useCallback(
    async (gen: number) => {
      setStatus('loading');
      setFailure(null);
      try {
        const availability = await checkHealthConnect();
        if (!isCurrent(gen)) return;
        if (availability !== 'available') {
          setStatus('unavailable');
          setFailure({
            kind: 'sdk',
            message:
              availability === 'update-required'
                ? 'Health Connect needs an update from the Play Store before it can share data.'
                : 'Health Connect is not available on this device.',
          });
          return;
        }
        ready.current = true;

        granted.current = await grantedVitalsPermissions();
        if (!isCurrent(gen)) return;
        if (granted.current.length === 0) {
          setStatus('permission-required');
          return;
        }
        await beginPolling(gen);
      } catch (error) {
        if (!isCurrent(gen)) return;
        setStatus('error');
        setFailure(describeFailure(error, 'sdk'));
      }
    },
    [beginPolling, isCurrent],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    generation.current += 1;
    const gen = generation.current;

    void start(gen);

    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);

    const onChange = (next: AppStateStatus) => {
      if (next !== 'active') return;
      const last = lastPolledRef.current;
      // Only when an interval has effectively already elapsed, so app-switching does not turn
      // into a read per switch. Before the first poll there is nothing to catch up on.
      if (last !== null && Date.now() - last >= POLL_INTERVAL_MS) void poll();
    };
    const subscription = AppState.addEventListener('change', onChange);

    // Tears down the enabled session — on disable as well as on unmount — and returns the feed
    // to idle so a later enable starts from an empty buffer. The `mounted` effect is declared
    // first, so its cleanup has already run on unmount and the state reset is skipped there;
    // on a plain disable it is what clears the screen.
    return () => {
      generation.current += 1;
      ready.current = false;
      active.current = false;
      granted.current = [];
      lastPolledRef.current = null;
      clearInterval(timer);
      subscription.remove();
      fold.current?.stop();
      fold.current = null;
      if (!mounted.current) return;
      setReadings([]);
      setStatus('idle');
      setFailure(null);
      setLastPolledAt(null);
    };
  }, [enabled, poll, start]);

  const requestAccess = useCallback(() => {
    if (!enabled || !ready.current) return;
    const gen = generation.current;
    void (async () => {
      try {
        const next = await requestVitalsAccess();
        if (!isCurrent(gen)) return;
        granted.current = next;
        if (next.length === 0) {
          setStatus('permission-required');
          return;
        }
        setStatus('loading');
        await beginPolling(gen);
      } catch (error) {
        if (!isCurrent(gen)) return;
        setStatus('error');
        setFailure(describeFailure(error, 'permission'));
      }
    })();
  }, [beginPolling, enabled, isCurrent]);

  const refresh = useCallback(() => {
    void poll();
  }, [poll]);

  return { readings, status, failure, lastPolledAt, requestAccess, refresh };
}
