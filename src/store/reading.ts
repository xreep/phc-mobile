/**
 * What of a `SensorReading` the store keeps, shared by both backends so they cannot drift.
 *
 * Persisted: `source`, `timestamp`, `hr`, `spo2`, `skinTempC`, `motionSummary`. Not persisted:
 * the raw `motion` vector — no adapter emits one today (the accelerometer fold produces
 * summaries), it is a per-sample value with no use to Trends or baselines, and a once-per-poll
 * vector cannot land on a fall impact anyway (`MotionSummary`'s doc). A reading whose only
 * payload is a raw vector has no row to write and is dropped by `append`.
 */

import type { SensorReading } from '@/risk';

export function hasMotionSummary(reading: SensorReading): boolean {
  return reading.motionSummary !== undefined;
}

export function isStorable(reading: SensorReading): boolean {
  return (
    reading.hr !== undefined ||
    reading.spo2 !== undefined ||
    reading.skinTempC !== undefined ||
    reading.motionSummary !== undefined
  );
}

/** A deep copy of the persisted fields only — `motion` is dropped here too. */
export function cloneStored(reading: SensorReading): SensorReading {
  const copy: {
    -readonly [K in keyof SensorReading]?: SensorReading[K];
  } = { source: reading.source, timestamp: reading.timestamp };
  if (reading.hr !== undefined) copy.hr = reading.hr;
  if (reading.spo2 !== undefined) copy.spo2 = reading.spo2;
  if (reading.skinTempC !== undefined) copy.skinTempC = reading.skinTempC;
  if (reading.motionSummary !== undefined) copy.motionSummary = { ...reading.motionSummary };
  return copy as SensorReading;
}

/**
 * Ascending by instant; at a tie, vitals before motion; at a full tie, insertion order (the
 * `seq` the caller assigned). Both backends sort by exactly this — the SQLite store in its
 * `ORDER BY`, the memory store here.
 */
export function compareStored(
  a: { readonly reading: SensorReading; readonly seq: number },
  b: { readonly reading: SensorReading; readonly seq: number },
): number {
  if (a.reading.timestamp !== b.reading.timestamp) return a.reading.timestamp - b.reading.timestamp;
  const motionA = hasMotionSummary(a.reading) ? 1 : 0;
  const motionB = hasMotionSummary(b.reading) ? 1 : 0;
  if (motionA !== motionB) return motionA - motionB;
  return a.seq - b.seq;
}
