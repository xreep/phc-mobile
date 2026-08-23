/**
 * Runs the Tier-1 risk engine (PRD §7.2.2) for the Dashboard, over the simulated sensor
 * window and the **live** environment observation from PRD §7.2.3.
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

import { buildEnvironmentSnapshot, buildMockReadings } from '@/constants/mock-sensor-window';
import { useEnvironmentFeed } from '@/environment/provider';
import { useNow } from '@/hooks/use-now';
import { assessRisk, type RiskAssessment, type SensorReading } from '@/risk';

/** Matches the simulated sensor cadence, so the window advances a sample per tick. */
export const RE_EVALUATE_INTERVAL_MS = 60 * 1000;

export type DashboardRisk = {
  readonly assessment: RiskAssessment;
  /**
   * Newest reading in the evaluated window, or null when the buffer is empty. Nullable
   * because a real ingestion buffer is empty at cold start, and the vitals row has to be
   * able to say so rather than render a stale number.
   */
  readonly latest: SensorReading | null;
};

export function useRiskAssessment(): DashboardRisk {
  const { environment } = useEnvironmentFeed();
  const now = useNow(RE_EVALUATE_INTERVAL_MS);

  return useMemo(() => {
    const readings = buildMockReadings(now);
    const assessment = assessRisk({
      readings,
      environment: buildEnvironmentSnapshot(environment),
      now,
    });
    return { assessment, latest: readings.at(-1) ?? null };
  }, [environment, now]);
}
