/**
 * Placeholder health data for the app shell (PRD §7.2.4).
 *
 * This is the swap-in point for the remaining simulated values: PRD §7.2.1 sensor
 * ingestion will replace the vitals and trend constants with live values behind the same
 * shapes. Nothing here reflects a real person — it is demo data.
 *
 * The environment constant that used to live here is **gone**, not moved. Weather, air
 * quality, and advisories are now fetched live for the device's coarse location — see
 * `src/environment/` and `src/app/environment.tsx`. Keeping a plausible-looking
 * `ENVIRONMENT` fallback beside a live feed is how a demo heat index ends up on screen
 * during an outage with nothing saying so, so there is deliberately nothing to fall back to.
 */

/** Traffic-light status. Subset of the theme's RiskColors keys. */
export type RiskLevel = 'green' | 'amber' | 'red';

/**
 * One dashboard risk card.
 *
 * The Dashboard no longer holds a hardcoded array of these: the Tier-1 rule engine
 * (PRD §7.2.2) produces them at runtime as `CategoryAssessment`, which extends this
 * shape with the score, fired rules, and data quality behind each verdict. This type
 * stays here because it is the contract `RiskCard` renders against and the engine's only
 * coupling to the app — see the header of `src/risk/types.ts`.
 */
export type RiskCategory = {
  /**
   * `heat` | `respiratory` | `cardiovascular` | `fall` are the four PRD §7.2.2 flag
   * categories. `dehydration` and `fatigue` are Tier-1 *advisory* categories: they are
   * computed by the same engine from the same window, but they are not among the six
   * §7.2.2 flags, so they never set `flagged` and never contribute to an SOS. Widening
   * this union is deliberately a breaking change — `CATEGORY_LABELS`, `CATEGORY_ORDER`
   * and the `outcomes` record in `assess.ts` are all keyed by it, so a new category
   * cannot be added without the compiler naming every place that has to handle it.
   */
  key: 'heat' | 'respiratory' | 'cardiovascular' | 'fall' | 'dehydration' | 'fatigue';
  label: string;
  level: RiskLevel;
  /** One-line, plain-language guidance shown under the status. */
  guidance: string;
  /** Short current-reading string, e.g. "SpO₂ 97%". */
  metric?: string;
};

/**
 * Terminal values of the demo sensor window — `mock-sensor-window.ts` builds a rolling
 * buffer that ends on these, so the vitals row and the engine-computed cards are reading
 * the same numbers by construction rather than by coincidence.
 *
 * There is no `updatedAt` here on purpose. Freshness is a property of the reading
 * timestamps the engine actually evaluated, so the Dashboard derives it from
 * `RiskAssessment` instead; a hardcoded string beside live-computed cards is exactly the
 * kind of claim that goes quietly out of date.
 */
export type VitalsSummary = {
  hr: number;
  spo2: number;
  skinTempC: number;
};

export const VITALS: VitalsSummary = {
  hr: 78,
  spo2: 97,
  skinTempC: 36.8,
};

export type TrendRange = '24h' | '7d';

export type TrendSeries = {
  key: 'hr' | 'spo2' | 'skinTemp';
  label: string;
  unit: string;
  current: number;
  min: number;
  avg: number;
  max: number;
  /** Ordered samples, oldest → newest, for the mini bar chart. */
  points: number[];
};

/** 24hr / 7-day vitals history (PRD §7.2.4 Trends). */
export const TRENDS: Record<TrendRange, TrendSeries[]> = {
  '24h': [
    {
      key: 'hr',
      label: 'Heart Rate',
      unit: 'bpm',
      current: 78,
      min: 58,
      avg: 74,
      max: 112,
      points: [62, 60, 59, 64, 72, 88, 95, 112, 84, 79, 76, 78],
    },
    {
      key: 'spo2',
      label: 'Blood Oxygen',
      unit: '%',
      current: 97,
      min: 94,
      avg: 97,
      max: 99,
      points: [98, 97, 96, 97, 95, 94, 96, 97, 98, 97, 98, 97],
    },
    {
      key: 'skinTemp',
      label: 'Skin Temperature',
      unit: '°C',
      current: 36.8,
      min: 36.2,
      avg: 36.7,
      max: 37.3,
      points: [36.3, 36.2, 36.4, 36.6, 36.9, 37.1, 37.3, 37.0, 36.8, 36.7, 36.8, 36.8],
    },
  ],
  '7d': [
    {
      key: 'hr',
      label: 'Heart Rate',
      unit: 'bpm',
      current: 78,
      min: 55,
      avg: 72,
      max: 118,
      points: [71, 69, 74, 118, 76, 73, 72],
    },
    {
      key: 'spo2',
      label: 'Blood Oxygen',
      unit: '%',
      current: 97,
      min: 92,
      avg: 96,
      max: 99,
      points: [97, 96, 95, 92, 96, 97, 97],
    },
    {
      key: 'skinTemp',
      label: 'Skin Temperature',
      unit: '°C',
      current: 36.8,
      min: 36.1,
      avg: 36.8,
      max: 37.6,
      points: [36.6, 36.7, 37.6, 37.2, 36.9, 36.8, 36.8],
    },
  ],
};

/*
 * Emergency contacts now live in persisted settings, not here.
 *
 * The demo array that used to sit at this spot held two realistic-looking Indian numbers, which
 * was harmless while SOS was a button with no `onPress` and became dangerous the moment it had
 * one: `+91 98765 43210` normalizes to a structurally valid E.164 number, so no validation
 * layer would have stopped a demo tap from texting a stranger. The list is empty by default —
 * see `src/settings/store.ts` — and `EmergencyContact` is declared in `src/sos/types.ts`, next
 * to the E.164 guarantee the send path depends on. Import it from `@/sos`.
 */

export type SensorSourceOption = {
  key: 'health_connect' | 'ble_esp32' | 'simulated';
  label: string;
  description: string;
};

export const SENSOR_SOURCES: SensorSourceOption[] = [
  {
    key: 'health_connect',
    label: 'Android Health Connect',
    description: 'Heart rate, SpO₂ & more from a paired band or watch.',
  },
  {
    key: 'ble_esp32',
    label: 'ESP32 Prototype (BLE)',
    description: 'Direct Bluetooth link to the demo sensor board.',
  },
  {
    key: 'simulated',
    label: 'Simulated data',
    description: 'Demo values for testing without hardware.',
  },
];

export const DEFAULT_SENSOR_SOURCE: SensorSourceOption['key'] = 'simulated';

export type DataSharingPref = {
  key: 'sos' | 'anon_aggregate' | 'cloud_backup' | 'family_share';
  label: string;
  description: string;
  /** Everything off by default except SOS (PRD §7.2.4 / §7.2.6). */
  defaultOn: boolean;
};

export const DATA_SHARING_PREFS: DataSharingPref[] = [
  {
    key: 'sos',
    label: 'Emergency SOS alerts',
    description: 'Send your location and risk summary to contacts in an emergency.',
    defaultOn: true,
  },
  {
    key: 'anon_aggregate',
    label: 'Anonymous community insights',
    description: 'Share coarse, de-identified risk trends with local responders.',
    defaultOn: false,
  },
  {
    key: 'cloud_backup',
    label: 'Encrypted cloud backup',
    description: 'Back up your on-device health history to the cloud.',
    defaultOn: false,
  },
  {
    key: 'family_share',
    label: 'Family caregiver view',
    description: 'Let a trusted contact see your live status.',
    defaultOn: false,
  },
];
