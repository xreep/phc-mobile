/**
 * The live environment feed as React state: cache-first, refreshed every 30 minutes, and
 * refreshable on demand (PRD §7.2.3).
 *
 * ## Cache first, then network
 * The cached observation is read and rendered before the fetch starts, so a cold launch
 * shows real numbers immediately instead of a spinner, and a launch with no connection
 * shows the last known good reading rather than an error. The screen is told which of the
 * two it is looking at via `status`.
 *
 * ## "Every 30 minutes when online"
 * There is no connectivity check, and that is deliberate rather than an omission. A
 * reachability flag routinely disagrees with whether a request will actually succeed —
 * captive portals, a connected radio with no route, a network that drops mid-flight — so
 * the feed attempts the fetch and falls back to cache on failure. That behaves correctly in
 * all of those cases and costs no extra dependency.
 *
 * An interval alone would not honour the 30-minute promise either: React Native throttles
 * and suspends JS timers while the app is backgrounded, so a phone left in a pocket for two
 * hours would resume showing two-hour-old data until the next tick happened to land. The
 * `AppState` listener closes that gap by refreshing on foreground when the data on screen
 * is already older than the interval — which is what makes "every 30 minutes" true in
 * practice rather than only while the app is open.
 *
 * ## Why the interval refresh must not prompt
 * Background refreshes pass `canPrompt: false`. A permission dialog appearing 30 minutes
 * in, unprompted, while the user is on another screen, is the kind of thing that gets a
 * permission permanently denied. The OS dialog is only ever raised by a user-initiated
 * action: first load, or an explicit refresh.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import {
  EnvironmentError,
  fetchLiveEnvironment,
  readCachedEnvironment,
  type EnvironmentFailure,
  type EnvironmentStatus,
  type LiveEnvironment,
} from '@/environment';

/** PRD §7.2.3. Also comfortably inside OpenWeatherMap's free-tier call budget. */
export const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

export type EnvironmentFeed = {
  readonly environment: LiveEnvironment | null;
  readonly status: EnvironmentStatus;
  /** Set whenever the last attempt failed, even when cached data is being shown. */
  readonly failure: EnvironmentFailure | null;
  /** True while a refresh is in flight and something is already on screen. */
  readonly refreshing: boolean;
  readonly refresh: () => void;
};

function describeFailure(error: unknown): EnvironmentFailure {
  if (error instanceof EnvironmentError) {
    return { message: error.message, kind: error.kind };
  }
  return { message: 'Could not update environment data.', kind: 'unknown' };
}

export function useEnvironment(): EnvironmentFeed {
  const [environment, setEnvironment] = useState<LiveEnvironment | null>(null);
  const [status, setStatus] = useState<EnvironmentStatus>('loading');
  const [failure, setFailure] = useState<EnvironmentFailure | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Guards every `setState` after an await. Without it, a fetch that resolves after the
  // screen unmounts updates a dead component; with a 10 s network timeout that is an
  // ordinary occurrence rather than an edge case.
  const mounted = useRef(true);
  const inFlight = useRef<AbortController | null>(null);
  /** Mirrors `environment.fetchedAt` for the AppState check, which must not re-subscribe
   *  every time the data changes. */
  const lastFetchedAt = useRef<number | null>(null);

  const load = useCallback(async (canPrompt: boolean) => {
    // A newer request supersedes an older one; the old response would otherwise land
    // afterwards and overwrite fresher data.
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    const now = Date.now();
    if (mounted.current) setRefreshing(true);

    try {
      const next = await fetchLiveEnvironment({ now, canPrompt, signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      lastFetchedAt.current = next.fetchedAt;
      setEnvironment(next);
      setStatus('live');
      setFailure(null);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      setFailure(describeFailure(error));

      // Fall back to whatever was last written. Read fresh rather than trusting the
      // current state: on a cold start that failed, state is still null.
      const cached = await readCachedEnvironment(now);
      if (!mounted.current || controller.signal.aborted) return;

      if (cached !== null) {
        lastFetchedAt.current = cached.fetchedAt;
        setEnvironment(cached);
        setStatus('cached');
      } else {
        setStatus('error');
      }
    } finally {
      if (mounted.current && inFlight.current === controller) {
        setRefreshing(false);
        inFlight.current = null;
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;

    void (async () => {
      // Paint the cached reading before the network call, so the screen is never empty
      // when there is something true to show.
      const cached = await readCachedEnvironment(Date.now());
      if (!mounted.current) return;
      if (cached !== null) {
        lastFetchedAt.current = cached.fetchedAt;
        setEnvironment(cached);
        setStatus('cached');
      }
      await load(true);
    })();

    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void load(false), REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next !== 'active') return;
      const fetchedAt = lastFetchedAt.current;
      // Only when the interval has effectively already elapsed, so returning to the app
      // repeatedly does not turn into a request per switch.
      if (fetchedAt === null || Date.now() - fetchedAt >= REFRESH_INTERVAL_MS) {
        void load(false);
      }
    };

    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [load]);

  const refresh = useCallback(() => {
    // User-initiated, so this is the one path allowed to raise the permission dialog:
    // a denial can be recovered from by tapping refresh again.
    void load(true);
  }, [load]);

  return { environment, status, failure, refreshing, refresh };
}
