/**
 * Runs the Tier-1 risk engine (PRD §7.2.2) for the Dashboard, over either the live Health
 * Connect buffer or the simulated sensor window, and the **live** environment observation from
 * PRD §7.2.3.
 *
 * ## Why the evaluation instant has to advance
 * The engine never reads a clock — `now` is passed in, which is what makes it
 * deterministic and testable. That put the earlier version of this hook on
 * `useState(() => Date.now())`: one read, frozen for the lifetime of the mount, which was
 * exactly right while the environment was a mock whose `observedAt` was itself derived from
 * that same frozen `now` and so could never age.
 *
 * A live observation has a real epoch `observedAt`, and that changes the calculus. Against a
 * frozen `now`, `now - observedAt` is a constant, so the weather could sit there for six
 * hours and the engine would keep scoring it as freshly observed — `env.maxStaleMs` (60 min)
 * would never be crossed, and the heat card would keep asserting a verdict from stale data
 * with no indication anything was wrong. That is a threshold rendered unsatisfiable by the
 * shape of its input, silently, which is the failure mode this engine has already had to be
 * dug out of four times.
 *
 * So `now` is re-read on a 60-second tick. The interval matches the simulated poll cadence,
 * costs one cheap re-render a minute, and is what lets the staleness bounds the engine
 * already implements actually fire. The tick itself lives in `useNow`, which the Environment
 * screen needs for the same reason — a frozen clock there freezes the "updated N ago" line.
 *
 * The environment arrives asynchronously and may be null on the first render; the engine
 * takes null and reports `dataQuality: 'missing'` for heat rather than guessing.
 */

import { useMemo } from 'react';

import {
  buildEnvironmentSnapshot,
  buildMockReadings,
  spliceSimulatedFall,
} from '@/constants/mock-sensor-window';
import { useEnvironmentFeed } from '@/environment/provider';
import { useNow } from '@/hooks/use-now';
import {
  assessRisk,
  computeVitalBaselines,
  type RiskAssessment,
  type SensorReading,
  type VitalBaselines,
} from '@/risk';
import { carriesVital, latestVitalsOf } from '@/sensors/latest-vitals';
import { useSensorFeed } from '@/sensors/provider';
import type { SensorFailure, SensorFeedStatus } from '@/sensors/types';
import { useSettings } from '@/settings/provider';

/** Matches the sensor poll cadence, so the window advances a sample per tick. */
export const RE_EVALUATE_INTERVAL_MS = 60 * 1000;

export type DashboardRisk = {
  readonly assessment: RiskAssessment;
  /**
   * Newest reading in the evaluated window, or null when the buffer is empty — which a live
   * buffer is at cold start, so the vitals row has to be able to say so.
   */
  readonly latest: SensorReading | null;
  /**
   * The newest value of each vital, composed across readings — what the SOS message quotes.
   * Distinct from `latest` because in live mode the newest reading is the motion-only summary
   * stamped at the poll instant, which carries no vitals (`latestVitalsOf`). Null when no
   * reading carries any.
   */
  readonly latestVitals: SensorReading | null;
  /**
   * How many readings carry at least one vital. `assessment.sampleCount` counts the phone's
   * motion-only readings too, so it is ≥ 1 from the first poll even when the band has never
   * synced — this is the number that says whether Health Connect has delivered anything.
   */
  readonly vitalReadingCount: number;
  /** Each vital against its rolling average over the same window (PRD §7.2.1 extension). */
  readonly baselines: VitalBaselines;
  /** True when the readings came from Health Connect rather than the simulated window. */
  readonly live: boolean;
  /** The feed's own state, so the Dashboard can say *why* a live buffer is empty. */
  readonly feedStatus: SensorFeedStatus;
  readonly feedFailure: SensorFailure | null;
  /** Raises the Health Connect permission dialog. User-initiated only. */
  readonly requestAccess: () => void;
};

export type UseRiskAssessmentOptions = {
  /**
   * Dev-only: splice a fall into the tail of whichever window is live (PRD §7.2.2). Shapes the
   * engine's *input* and nothing else — see `MockReadingOptions` for why the demo trigger has
   * to work that way to prove anything.
   */
  readonly simulateFall?: boolean;
};

export function useRiskAssessment(options: UseRiskAssessmentOptions = {}): DashboardRisk {
  const { environment } = useEnvironmentFeed();
  const feed = useSensorFeed();
  const { settings } = useSettings();
  const now = useNow(RE_EVALUATE_INTERVAL_MS);
  const simulateFall = options.simulateFall === true;
  const live = settings.sensorSource === 'health_connect';
  const liveReadings = feed.readings;

  return useMemo(() => {
    // The one place the app decides which buffer is real. `live` is read from Settings, not
    // from the feed's status, so a feed that is switched on but empty scores as "no data"
    // rather than quietly showing the simulated window under a Health Connect label.
    const readings = live
      ? simulateFall
        ? spliceSimulatedFall(liveReadings, now)
        : liveReadings
      : buildMockReadings(now, { simulateFall });

    const assessment = assessRisk({
      readings,
      environment: buildEnvironmentSnapshot(environment),
      now,
    });
    return {
      assessment,
      latest: readings.at(-1) ?? null,
      latestVitals: latestVitalsOf(readings),
      vitalReadingCount: readings.filter(carriesVital).length,
      baselines: computeVitalBaselines({ readings, assessment }),
      live,
      feedStatus: feed.status,
      feedFailure: feed.failure,
      requestAccess: feed.requestAccess,
    };
  }, [environment, feed.failure, feed.requestAccess, feed.status, live, liveReadings, now, simulateFall]);
}
