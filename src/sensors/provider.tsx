/**
 * One sensor feed for the whole app.
 *
 * Same reasoning as `environment/provider.tsx`: the Dashboard's risk engine and (later) the
 * Trends screen read one buffer, so there is one accelerometer subscription and one poll
 * timer, and two screens can never disagree about what the newest reading is.
 *
 * The feed is gated here, not in the hook's callers: Settings' "Sensor source" picker is the
 * single switch, and reading it in one place is what keeps a demo on the simulated window
 * from quietly also polling Health Connect underneath.
 *
 * Also gated on the reading store being `ready` (M6): the store provider serves a placeholder
 * until SQLite has opened or failed, and a first poll that landed in the placeholder would be
 * lost when the real store took over — the warm start the store exists for. The wait is the
 * length of one database open, in the tens of milliseconds.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { useSensors } from '@/hooks/use-sensors';
import type { SensorFeed } from '@/sensors/types';
import { useSettings } from '@/settings/provider';
import { useReadingStore } from '@/store/provider';

const SensorContext = createContext<SensorFeed | null>(null);

export function SensorProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const { store, ready } = useReadingStore();
  const feed = useSensors({ enabled: ready && settings.sensorSource === 'health_connect', store });
  return <SensorContext.Provider value={feed}>{children}</SensorContext.Provider>;
}

/**
 * Throws when no provider is mounted, deliberately — an inert default would render an empty
 * vitals row and a Dashboard scoring nothing, with no fault reported anywhere.
 */
export function useSensorFeed(): SensorFeed {
  const feed = useContext(SensorContext);
  if (feed === null) {
    throw new Error('useSensorFeed must be used inside a <SensorProvider>.');
  }
  return feed;
}
