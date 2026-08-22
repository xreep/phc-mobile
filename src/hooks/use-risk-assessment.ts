/**
 * Runs the Tier-1 risk engine (PRD §7.2.2) for the Dashboard.
 *
 * The single place the app decides *what* to assess, so the Dashboard does not have to
 * know that the readings are currently synthetic. When PRD §7.2.1 ingestion lands, this
 * hook subscribes to the sensor store instead of calling the mock builders; nothing in
 * `index.tsx` changes.
 *
 * ## Why `now` is frozen
 * `assessRisk` is pure and takes the evaluation instant as an argument — it never reads a
 * clock. Calling `Date.now()` in the render body would make every render produce a
 * slightly different assessment, so `useMemo` could never cache and a duration that sits
 * near a threshold would flicker between levels while the user reads the screen. Freezing
 * one instant per mount makes the render deterministic. It also means the demo does not
 * age into staleness while the screen is open, which is the honest behaviour for fixture
 * data: with real sensors, each new reading supplies its own fresh `now`.
 */

import { useMemo, useState } from 'react';

import { buildMockEnvironment, buildMockReadings } from '@/constants/mock-sensor-window';
import { assessRisk, type RiskAssessment, type SensorReading } from '@/risk';

export type DashboardRisk = {
  readonly assessment: RiskAssessment;
  /**
   * The reading the assessment was computed from, or `null` when the buffer is empty.
   *
   * Returned alongside the assessment so the vitals row and the risk cards are rendering
   * the same tick. Nullable because a real buffer is empty at cold start, before the
   * first poll returns — the Dashboard has to have something to show then.
   */
  readonly latest: SensorReading | null;
};

export function useRiskAssessment(): DashboardRisk {
  // Lazy initialiser, so the clock is read once at mount rather than on every render.
  const [now] = useState(() => Date.now());

  return useMemo(() => {
    const readings = buildMockReadings(now);
    const assessment = assessRisk({
      readings,
      environment: buildMockEnvironment(now),
      now,
    });

    return { assessment, latest: readings.at(-1) ?? null };
  }, [now]);
}
