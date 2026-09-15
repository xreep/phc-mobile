/**
 * The vitals the SOS message should quote, composed from a live buffer (PRD §7.2.5).
 *
 * The live feed's newest reading is the phone's motion summary, stamped at the poll instant so
 * `rules/fall.ts` can anchor its trailing-still run on it. That reading carries no vitals, so
 * `readings.at(-1)` is the wrong thing to hand `useSos`: it would build a message with no
 * vitals line while an HR sample from 30 s ago sits in the buffer. Each vital arrives in its
 * own reading, at its own cadence — one composite made from the newest value of *each* field
 * is what a responder actually wants to read.
 *
 * On the simulated window every reading carries every vital, so the composite equals the
 * newest reading and the mock path is unchanged.
 */

import type { SensorReading } from '@/risk';

const VITAL_FIELDS = ['hr', 'spo2', 'skinTempC'] as const;
type VitalField = (typeof VITAL_FIELDS)[number];

/**
 * A reading holding the newest `hr`, `spo2`, and `skinTempC` in `readings`, each chosen
 * independently; `timestamp`/`source` are the newest contributing reading's. Null when no
 * reading carries any vital. Order-independent, so an unsorted buffer is fine.
 */
export function latestVitalsOf(readings: readonly SensorReading[]): SensorReading | null {
  let newest: SensorReading | null = null;
  const picked: Partial<Record<VitalField, SensorReading>> = {};

  for (const reading of readings) {
    let carriesVital = false;
    for (const field of VITAL_FIELDS) {
      if (reading[field] === undefined) continue;
      carriesVital = true;
      const current = picked[field];
      if (current === undefined || reading.timestamp > current.timestamp) picked[field] = reading;
    }
    if (carriesVital && (newest === null || reading.timestamp > newest.timestamp)) newest = reading;
  }

  if (newest === null) return null;

  const composite: { -readonly [K in keyof SensorReading]?: SensorReading[K] } = {
    source: newest.source,
    timestamp: newest.timestamp,
  };
  for (const field of VITAL_FIELDS) {
    const from = picked[field];
    if (from !== undefined) composite[field] = from[field];
  }
  return composite as SensorReading;
}
