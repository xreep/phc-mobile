/**
 * Placeholder health + environment data for the static app shell (PRD §7.2.4).
 *
 * This is the single swap-in point for real data later: the sensor-ingestion
 * (§7.2.1), risk-engine (§7.2.2), and environmental-context (§7.2.3) phases
 * will replace these constants with live values behind the same shapes. Nothing
 * here reflects a real person — it is demo data.
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
  key: 'heat' | 'respiratory' | 'cardiovascular' | 'fall';
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

export type Advisory = {
  id: string;
  source: string;
  title: string;
  detail: string;
  level: RiskLevel;
};

export type EnvironmentData = {
  location: string;
  updatedAt: string;
  tempC: number;
  humidity: number;
  heatIndexC: number;
  heatIndexBand: { label: string; level: RiskLevel };
  aqi: number;
  aqiCategory: { label: string; level: RiskLevel };
  advisories: Advisory[];
};

/** Local weather, AQI, and active advisories (PRD §7.2.3 / §7.2.4). */
export const ENVIRONMENT: EnvironmentData = {
  location: 'Chennai, Tamil Nadu',
  updatedAt: '12 min ago',
  tempC: 38,
  humidity: 62,
  // Derived, not invented: 38 °C at 62 % RH is 133.5 °F = 56.4 °C by the NOAA
  // regression, which is Extreme Danger (≥125 °F), not Danger. Demo data that
  // contradicts the formula misleads anyone reading it as a worked example, so
  // `src/risk/__tests__/heat-index.test.ts` asserts these three fields against
  // `computeHeatIndexC(tempC, humidity)` and fails if they drift again.
  heatIndexC: 56.4,
  heatIndexBand: { label: 'Extreme Danger', level: 'red' },
  aqi: 168,
  aqiCategory: { label: 'Unhealthy', level: 'red' },
  advisories: [
    {
      id: 'imd-heat',
      source: 'IMD',
      title: 'Heat wave warning',
      detail: 'Severe heat expected 11am–4pm. Stay indoors, hydrate, check on elderly neighbours.',
      level: 'amber',
    },
    {
      id: 'cpcb-aqi',
      source: 'CPCB',
      title: 'Poor air quality',
      detail: 'PM2.5 elevated. Limit outdoor exertion; sensitive groups should wear a mask.',
      level: 'red',
    },
  ],
};

export type EmergencyContact = {
  id: string;
  name: string;
  relation: string;
  phone: string;
};

export const EMERGENCY_CONTACTS: EmergencyContact[] = [
  { id: 'c1', name: 'Priya Sharma', relation: 'Sister', phone: '+91 98765 43210' },
  { id: 'c2', name: 'Dr. Anand Rao', relation: 'Physician', phone: '+91 91234 56780' },
];

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
