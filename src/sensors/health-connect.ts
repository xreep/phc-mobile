/**
 * Android Health Connect adapter (PRD §6.4, §7.2.1) — the `HealthConnectAdapter` the PRD
 * names, producing PRD §7.2.1's unified `SensorReading`.
 *
 * ## Two layers in one file
 * The mappers are pure and take *structural* subsets of the library's record results, so they
 * are unit-tested with plain objects and never see a native call. The I/O functions below
 * them are thin: they call the library and hand the records to the mappers. Mirrors
 * `environment/openweather.ts` (mappers) + `environment/service.ts` (fetch) at smaller scale.
 *
 * ## Why every reading carries one vital
 * Health Connect stores heart rate, SpO₂ and skin temperature as separate record types with
 * independent timestamps. Merging them into one reading would mean inventing an alignment,
 * and `risk/types.ts` already says the engine reads `undefined` as "no signal" — so a reading
 * with just `hr` is the honest shape. The vitals row and the baseline module work per field.
 *
 * ## Skin temperature is a delta series
 * `SkinTemperatureRecord` holds `deltas` against an optional `baseline`. Without the baseline
 * there is no absolute skin temperature to report, and a delta of −0.3 is not one, so such a
 * record produces no readings. `BodyTemperature` is deliberately *not* read as a substitute:
 * it is core temperature, and `SensorReading.skinTempC` is documented as skin.
 *
 * ## No plausibility filtering here
 * The engine owns the physiological gate (`thresholds.plausible`). The adapter only refuses
 * values that are not numbers or instants that do not parse — anything numeric goes through,
 * so a genuinely alarming reading is never silenced at the adapter.
 */

import type { SensorReading } from '@/risk';

export const HEALTH_CONNECT_SOURCE = 'health_connect' as const;

// ---------------------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------------------

/** Structural subset of `RecordResult<'HeartRate'>` — what the mapper actually reads. */
export type HeartRateInput = {
  readonly samples: readonly { readonly time: string; readonly beatsPerMinute: number }[];
};

/** Structural subset of `RecordResult<'OxygenSaturation'>`. */
export type OxygenSaturationInput = {
  readonly time: string;
  readonly percentage: number;
};

/** Structural subset of `RecordResult<'SkinTemperature'>`. `inFahrenheit` is carried (rather
 *  than narrowed away) only so the library's `TemperatureResult`/`TemperatureDeltaResult` —
 *  which always populate both units — assign here without an excess-property mismatch; the
 *  mapper itself reads `inCelsius` alone. */
export type SkinTemperatureInput = {
  readonly baseline?: { readonly inCelsius: number; readonly inFahrenheit: number };
  readonly deltas: readonly {
    readonly time: string;
    readonly delta: { readonly inCelsius: number; readonly inFahrenheit: number };
  }[];
};

function parseInstant(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function mapHeartRate(records: readonly HeartRateInput[]): SensorReading[] {
  const out: SensorReading[] = [];
  for (const record of records) {
    for (const sample of record.samples) {
      const timestamp = parseInstant(sample.time);
      if (timestamp === null || !Number.isFinite(sample.beatsPerMinute)) continue;
      out.push({ source: HEALTH_CONNECT_SOURCE, timestamp, hr: sample.beatsPerMinute });
    }
  }
  return out;
}

export function mapOxygenSaturation(records: readonly OxygenSaturationInput[]): SensorReading[] {
  const out: SensorReading[] = [];
  for (const record of records) {
    const timestamp = parseInstant(record.time);
    if (timestamp === null || !Number.isFinite(record.percentage)) continue;
    out.push({ source: HEALTH_CONNECT_SOURCE, timestamp, spo2: record.percentage });
  }
  return out;
}

export function mapSkinTemperature(records: readonly SkinTemperatureInput[]): SensorReading[] {
  const out: SensorReading[] = [];
  for (const record of records) {
    const baseline = record.baseline?.inCelsius;
    if (baseline === undefined || !Number.isFinite(baseline)) continue;
    for (const sample of record.deltas) {
      const timestamp = parseInstant(sample.time);
      const delta = sample.delta.inCelsius;
      if (timestamp === null || !Number.isFinite(delta)) continue;
      out.push({ source: HEALTH_CONNECT_SOURCE, timestamp, skinTempC: baseline + delta });
    }
  }
  return out;
}
