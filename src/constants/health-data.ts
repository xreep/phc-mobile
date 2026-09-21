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
 * Severity rung the guidance was chosen at (PRD §7.2.4 extension).
 *
 * Deliberately *not* a second traffic light. `RiskLevel` is the card's colour and comes from
 * the score's band; the tier is a finer cut *inside* a band, so a category can say something
 * different at the bottom of amber than at the top of it. The engine guarantees the two agree
 * — `mild` never appears on a red card, `severe` never on an amber one — which is enforced in
 * `src/risk/rules/recommend.ts` rather than by convention.
 */
export type RiskTier = 'mild' | 'moderate' | 'severe';

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
  /** One-line, plain-language guidance shown under the status. Tier-selected — see `tier`. */
  guidance: string;
  /**
   * Which rung of the category's ladder `guidance` came from, or `null` when nothing is
   * elevated and the line is the steady-state one. Optional so a hand-built category (a
   * placeholder, a fixture) does not have to invent one.
   */
  tier?: RiskTier | null;
  /** Concrete steps for that rung, most urgent first. Empty when `tier` is `null`. */
  actions?: readonly string[];
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

/**
 * The Trends screen's range picker (PS §7a "daily summaries and trend analysis").
 *
 * The series themselves are no longer a constant here: `src/app/trends.tsx` reads real history
 * from the persisted reading store via `useTrends` (`src/hooks/use-trends.ts`), aggregated by
 * `src/trends/aggregate.ts`. This type stays because it is the one small shape both that hook
 * and the screen's range toggle share.
 */
export type TrendRange = '24h' | '7d';

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
