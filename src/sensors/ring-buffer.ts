/**
 * The live feed's rolling buffer, as a pure merge (PRD §7.2.1).
 *
 * The engine takes "a longer buffer" and slices its own windows, so the buffer's only jobs
 * are: keep readings ascending, never hold the same sample twice, and never drop one the
 * engine could still need. Retention is a parameter rather than a constant here because the
 * hook derives it from `longestLookbackMs` — this module must not know what the engine's
 * lookback is, only respect the number it is given.
 *
 * Deduplication keys on the instant plus *which* vitals the reading carries, not on value.
 * Health Connect re-reads over an overlapping range return the same sample with the same
 * value, so first-wins is correct; and two readings at one instant carrying different vitals
 * (an HR sample and an SpO₂ record) are legitimately distinct.
 */

import type { SensorReading } from '@/risk';

export type MergeOptions = {
  readonly now: number;
  /** Readings older than `now − retainMs` are dropped. Inclusive at the boundary. */
  readonly retainMs: number;
};

/**
 * The dedupe key. Exported so the persistent store (`@/store`) keys rows on exactly this string
 * and the two can never disagree about whether a reading is "already held".
 */
export function identity(reading: SensorReading): string {
  return [
    reading.timestamp,
    reading.source,
    reading.hr !== undefined ? 'h' : '',
    reading.spo2 !== undefined ? 's' : '',
    reading.skinTempC !== undefined ? 't' : '',
    reading.motionSummary !== undefined || reading.motion !== undefined ? 'm' : '',
  ].join('|');
}

export function mergeReadings(
  buffer: readonly SensorReading[],
  incoming: readonly SensorReading[],
  { now, retainMs }: MergeOptions,
): SensorReading[] {
  const cutoff = now - retainMs;
  const seen = new Set<string>();
  const merged: SensorReading[] = [];

  for (const reading of [...buffer, ...incoming]) {
    if (reading.timestamp < cutoff) continue;
    const key = identity(reading);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(reading);
  }

  // `Array.prototype.sort` is stable, so equal-timestamp readings keep insertion order — the
  // hook relies on that to keep its motion reading newest at the poll instant.
  return merged.sort((a, b) => a.timestamp - b.timestamp);
}
