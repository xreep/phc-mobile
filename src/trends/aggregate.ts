/**
 * Pure aggregation over the persisted reading store (PRD §7.2.1 buffer, PS §7a "daily summaries
 * and trend analysis").
 *
 * No React, no clock, no store access — this module only turns a `SensorReading[]` the caller
 * already has into the numbers the Trends screen and (later) daily summaries need. That mirrors
 * `src/risk/window.ts`'s discipline: everything here is a pure function of its arguments, so it
 * can be unit tested without a provider tree and reused from both `useTrends` and any future
 * daily-summary surface.
 *
 * ## The plausibility gate is re-derived, not imported
 * `src/risk/window.ts`'s `collectSamples` already does exactly this filtering, but it is not part
 * of `@/risk`'s public surface (only its `VitalField` type is) — the barrel's header says the
 * engine "imports exactly four *types* from `@/constants/health-data` and nothing else from the
 * app", and reaching past the barrel into `@/risk/window` would be the same kind of undocumented
 * coupling in the other direction. So `isPlausible` below re-implements the one-line check
 * (finite number, inside `DEFAULT_RISK_THRESHOLDS.plausible[field]`) rather than importing it.
 * Both copies must stay inside the same bounds; a chart built from a physically impossible
 * artefact (a −40 °C skin temperature, a 999 bpm heart rate) is the thing this exists to prevent.
 */

import { DEFAULT_RISK_THRESHOLDS } from '@/risk';
import type { NumericRange, SensorReading, TimedValue, VitalField } from '@/risk';

const UNIT_FOR_FIELD: Record<VitalField, string> = {
  hr: 'bpm',
  spo2: '%',
  skinTempC: '°C',
};

function isPlausible(value: number, range: NumericRange): boolean {
  return Number.isFinite(value) && value >= range.min && value <= range.max;
}

/** Pull one vital's finite, physiologically-plausible samples out of a reading list. Order is
 *  not assumed and not guaranteed on the way out — callers that need ascending order sort. */
function plausibleSamples(
  readings: readonly SensorReading[],
  field: VitalField,
  range: NumericRange,
): TimedValue[] {
  const samples: TimedValue[] = [];
  for (const reading of readings) {
    const value = reading[field];
    if (value === undefined) continue;
    if (!isPlausible(value, range)) continue;
    samples.push({ value, timestamp: reading.timestamp });
  }
  return samples;
}

export type TrendSummary = {
  readonly field: VitalField;
  readonly unit: string;
  /** Newest sample's value inside the range. */
  readonly current: number;
  readonly min: number;
  readonly avg: number;
  readonly max: number;
  /** Count of samples that passed the plausibility gate and fell inside `[from, to]`. */
  readonly sampleCount: number;
  /** One mean per bucket, oldest → newest; `null` where the bucket held no sample. */
  readonly points: readonly (number | null)[];
};

export type SummarizeTrendOptions = {
  /** Inclusive lower bound, epoch ms. */
  readonly from: number;
  /** Inclusive upper bound, epoch ms. */
  readonly to: number;
  /** How many equal-width buckets to divide `[from, to]` into. Must be ≥ 1. */
  readonly buckets: number;
};

/**
 * Summarize one vital's history into min/avg/max/current plus a bucketed sparkline.
 *
 * Bucket boundaries are computed from `(timestamp - from) / bucketWidth`, floored, and clamped
 * into `[0, buckets - 1]` — the clamp is what keeps a sample landing exactly on `to` inside the
 * last bucket rather than one past the end (a half-open `[from, to)` bucketing would instead
 * drop it, silently under-counting the newest instant, which is the one most likely to be
 * `current`).
 *
 * Returns `null` when nothing plausible falls in range — an empty chart with a min/avg/max of
 * `0` reads as "everything is zero", which is a worse lie than "nothing recorded".
 */
export function summarizeTrend(
  readings: readonly SensorReading[],
  field: VitalField,
  { from, to, buckets }: SummarizeTrendOptions,
): TrendSummary | null {
  const range = DEFAULT_RISK_THRESHOLDS.plausible[field];
  const inRange = plausibleSamples(readings, field, range).filter(
    (sample) => sample.timestamp >= from && sample.timestamp <= to,
  );

  if (inRange.length === 0) return null;

  // Ascending, so "current" is unambiguously the newest and the bucket scan reads left to right.
  // Stable sort keeps same-instant samples in their original (insertion) order.
  const ascending = [...inRange].sort((a, b) => a.timestamp - b.timestamp);

  const bucketWidthMs = (to - from) / buckets;
  const sums = new Array<number>(buckets).fill(0);
  const counts = new Array<number>(buckets).fill(0);

  let min = ascending[0].value;
  let max = ascending[0].value;
  let total = 0;

  for (const sample of ascending) {
    if (sample.value < min) min = sample.value;
    if (sample.value > max) max = sample.value;
    total += sample.value;

    const rawIndex = bucketWidthMs > 0 ? Math.floor((sample.timestamp - from) / bucketWidthMs) : 0;
    const index = Math.min(buckets - 1, Math.max(0, rawIndex));
    sums[index] += sample.value;
    counts[index] += 1;
  }

  const points: (number | null)[] = sums.map((sum, i) => (counts[i] === 0 ? null : sum / counts[i]));

  return {
    field,
    unit: UNIT_FOR_FIELD[field],
    current: ascending[ascending.length - 1].value,
    min,
    max,
    avg: total / ascending.length,
    sampleCount: ascending.length,
    points,
  };
}

export type DailyVitalSummary = {
  readonly min: number;
  readonly avg: number;
  readonly max: number;
  readonly sampleCount: number;
};

export type DailySummary = {
  readonly hr: DailyVitalSummary | null;
  readonly spo2: DailyVitalSummary | null;
  readonly skinTempC: DailyVitalSummary | null;
  /**
   * Minutes (by `Math.floor((timestamp - dayStart) / 60_000)`, deduplicated) that held at least
   * one reading with `hr > heartRate.tachycardiaAbove` or `spo2 < spo2.flagBelow` — the PRD
   * §7.2.2 flag lines, read from `DEFAULT_RISK_THRESHOLDS` rather than restated as literals here,
   * so a threshold retune in `risk/config.ts` moves this too instead of quietly drifting from it.
   */
  readonly elevatedMinutes: number;
};

export type DailySummaryOptions = {
  /** Inclusive lower bound, epoch ms. */
  readonly dayStart: number;
  /** Inclusive upper bound, epoch ms. */
  readonly dayEnd: number;
};

const DAILY_FIELDS: readonly VitalField[] = ['hr', 'spo2', 'skinTempC'];

function summarizeDailyVital(
  readings: readonly SensorReading[],
  field: VitalField,
  { dayStart, dayEnd }: DailySummaryOptions,
): DailyVitalSummary | null {
  const range = DEFAULT_RISK_THRESHOLDS.plausible[field];
  const samples = plausibleSamples(readings, field, range).filter(
    (sample) => sample.timestamp >= dayStart && sample.timestamp <= dayEnd,
  );
  if (samples.length === 0) return null;

  let min = samples[0].value;
  let max = samples[0].value;
  let total = 0;
  for (const sample of samples) {
    if (sample.value < min) min = sample.value;
    if (sample.value > max) max = sample.value;
    total += sample.value;
  }
  return { min, max, avg: total / samples.length, sampleCount: samples.length };
}

/**
 * Per-vital min/avg/max over one day, plus how many distinct minutes crossed a PRD §7.2.2 flag
 * line. Each vital's plausibility gate is applied independently, exactly as `summarizeTrend`'s
 * is — a rejected heart-rate artefact must not also suppress a perfectly good SpO₂ sample from
 * the same reading.
 */
export function dailySummary(
  readings: readonly SensorReading[],
  options: DailySummaryOptions,
): DailySummary {
  const { dayStart, dayEnd } = options;
  const { heartRate, spo2, plausible } = DEFAULT_RISK_THRESHOLDS;

  const elevatedMinutes = new Set<number>();
  for (const reading of readings) {
    if (reading.timestamp < dayStart || reading.timestamp > dayEnd) continue;

    const hrElevated =
      reading.hr !== undefined &&
      isPlausible(reading.hr, plausible.hr) &&
      reading.hr > heartRate.tachycardiaAbove;
    const spo2Low =
      reading.spo2 !== undefined &&
      isPlausible(reading.spo2, plausible.spo2) &&
      reading.spo2 < spo2.flagBelow;

    if (hrElevated || spo2Low) {
      elevatedMinutes.add(Math.floor((reading.timestamp - dayStart) / 60_000));
    }
  }

  const [hr, spo2Summary, skinTempC] = DAILY_FIELDS.map((field) =>
    summarizeDailyVital(readings, field, options),
  );

  return { hr, spo2: spo2Summary, skinTempC, elevatedMinutes: elevatedMinutes.size };
}
