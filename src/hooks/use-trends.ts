/**
 * The Trends screen's data hook: real history from the persisted reading store, aggregated per
 * range (PRD §7.2.1 buffer; PS §7a "daily summaries and trend analysis").
 *
 * ## Same discipline as `use-environment.ts` / `use-sensors.ts`
 * A `mounted` ref guards every `setState` after an `await` — a range switch, or an unmount while
 * a read is in flight, must not update a dead component.
 *
 * ## Why `status` distinguishes `unavailable` from `empty`
 * A `MemoryReadingStore` only exists at runtime when SQLite failed to open
 * (`store/provider.tsx`'s module doc), so on a real device, whatever lands there does not
 * survive a restart. That is only worth a dedicated warning when the *live* source is actually
 * Health Connect — `src/store/types.ts`'s "simulated readings are never written" rule means
 * nothing else in this build writes real history at all, so `empty` already says everything a
 * memory backend on another source would need to. `ble_esp32` is deliberately excluded from
 * this gate for the same reason: it does not populate the store today (`SensorProvider` only
 * enables `useSensors` for `'health_connect'`), so the fallback message would describe a failure
 * mode that cannot yet occur for it.
 *
 * ## Simulated-source handling lives in the screen, not here
 * `TrendsStatus` has no "simulated" member. Whether the *current* picker is on simulated data is
 * a display decision — always show the "switch to Health Connect" banner and never the chart —
 * not a data one: history left over from an earlier Health Connect session should still be
 * readable if the user switches back, so this hook keeps reading and reporting real numbers
 * regardless of the picker. `src/app/trends.tsx` is what special-cases it.
 */

import { useEffect, useRef, useState } from 'react';

import type { TrendRange } from '@/constants/health-data';
import type { SensorReading, VitalField } from '@/risk';
import { useSensorFeed } from '@/sensors/provider';
import { useSettings } from '@/settings/provider';
import { useReadingStore } from '@/store/provider';
import { summarizeTrend, type TrendSummary } from '@/trends/aggregate';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 24 h → 24 hourly buckets; 7 d → 28 six-hourly buckets (design doc, PS §7a). */
export const TREND_RANGE_CONFIG: Record<TrendRange, { readonly ms: number; readonly buckets: number }> = {
  '24h': { ms: DAY_MS, buckets: 24 },
  '7d': { ms: 7 * DAY_MS, buckets: 28 },
};

/** hr, spo2, skinTempC — the Trends screen's fixed card order. */
const VITAL_ORDER: readonly VitalField[] = ['hr', 'spo2', 'skinTempC'];

export type TrendsStatus = 'loading' | 'ready' | 'empty' | 'unavailable';

export type UseTrendsResult = {
  /** Empty-bucket vitals are dropped entirely — a series with zero plausible samples in range
   *  has nothing to chart, rather than a zeroed-out card. */
  readonly series: readonly TrendSummary[];
  readonly status: TrendsStatus;
};

export function useTrends(range: TrendRange): UseTrendsResult {
  const { store, backend } = useReadingStore();
  const { lastPolledAt } = useSensorFeed();
  const { settings } = useSettings();

  const [series, setSeries] = useState<readonly TrendSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      const now = Date.now();
      const { ms, buckets } = TREND_RANGE_CONFIG[range];
      const from = now - ms;

      let readings: readonly SensorReading[];
      try {
        readings = await store.readSince(from, now);
      } catch {
        // A store failure here is history going missing, not the feed going down — the
        // Dashboard's fallback-to-memory-merge does not apply, since there is no live buffer to
        // fall back to. Reporting `empty` is honest: nothing readable was found.
        readings = [];
      }
      if (cancelled || !mounted.current) return;

      const next = VITAL_ORDER.map((field) =>
        summarizeTrend(readings, field, { from, to: now, buckets }),
      ).filter((summary): summary is TrendSummary => summary !== null);

      setSeries(next);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [range, store, lastPolledAt]);

  const unavailable = backend === 'memory' && settings.sensorSource === 'health_connect';
  const status: TrendsStatus = unavailable
    ? 'unavailable'
    : loading
      ? 'loading'
      : series.length === 0
        ? 'empty'
        : 'ready';

  return { series, status };
}
