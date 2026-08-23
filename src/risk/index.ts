/**
 * Tier-1 rule-based risk engine (PRD §7.2.2) — public surface.
 *
 * Framework-agnostic and side-effect free: no React, no react-native, no Expo, no
 * clock, no I/O, no module state. It imports exactly three *types* from
 * `@/constants/health-data` and nothing else from the app, which is what lets it be
 * unit-tested in isolation and dropped into both the sensor pipeline and the Dashboard.
 *
 * ## Usage
 * ```ts
 * import { assessRisk } from '@/risk';
 *
 * const assessment = assessRisk({
 *   readings,                    // rolling buffer, oldest → newest
 *   environment,                 // from the environmental-context module (§7.2.3)
 *   now: Date.now(),             // the engine never reads a clock itself
 * });
 *
 * assessment.categories;         // drop-in for RISK_CATEGORIES.map(…)
 * assessment.sosCandidate;       // handoff to the SOS module (§7.2.5)
 * ```
 *
 * ## What this layer is not
 * This is Tier 1 only — the always-on rule layer. The Tier-2 TFLite model and the
 * fusion that weights the two are a later phase. `CategoryAssessment.score` is on the
 * same 0–100 scale the ML output will use, and `envMultiplier` is reported rather than
 * applied, precisely so fusion can combine them without double-counting.
 *
 * It also never *acts*. Critical rules are reported through `criticalRules` and
 * `sosCandidate`; the 30-second cancel window, GPS, messaging, and the consent gate all
 * belong to the SOS module.
 *
 * ## `computeVitalBaselines` is the one export that is not a judgement
 * PRD §7.2.1's baseline extension describes the same readings rather than assessing them — it
 * returns no level, no score, and no rule id, and nothing downstream may treat a deviation as
 * a seventh risk signal. It lives here because it needs the same thresholds, the same
 * plausibility gate, and the same window primitives; it is deliberately not part of
 * `RiskAssessment`, and it takes an assessment as *input* so the two cannot describe different
 * stretches of time.
 */

export { assessRisk } from './assess';

export {
  computeVitalBaselines,
  formatWindowLabel,
  type BaselineDelta,
  type BaselineDirection,
  type BaselineReport,
  type VitalBaselineInput,
  type VitalBaselines,
} from './baseline';

export {
  DEFAULT_RISK_THRESHOLDS,
  resolveRiskThresholds,
  RISK_ENGINE_TIER,
} from './config';

export {
  celsiusToFahrenheit,
  computeHeatIndexC,
  computeHeatIndexF,
  fahrenheitToCelsius,
  heatIndexBandForC,
  heatIndexBandForF,
  isHeatIndexOutOfDomain,
  isHeatStressFlaggedF,
  rothfuszHeatIndexF,
  HEAT_INDEX_BAND_MIN_F,
  HEAT_INDEX_BANDS,
  HEAT_INDEX_MAX_VALID_TEMP_F,
  HEAT_STRESS_FLAG_MIN_F,
  type HeatIndexBand,
  type HeatIndexBandLabel,
} from './heat-index';

export { CATEGORY_LABELS, SCORE_BANDS } from './rules/shared';

export { CRITICAL_RULES, SPEC_FLAG_RULES } from './types';

export type {
  CategoryAssessment,
  DataQuality,
  EnvironmentSnapshot,
  MotionSummary,
  MotionVector,
  NumericRange,
  PartialRiskThresholds,
  RiskAssessment,
  RiskAssessmentInput,
  RiskCategory,
  RiskCategoryKey,
  RiskLevel,
  RiskThresholds,
  RuleId,
  SensorReading,
  SensorSource,
  TimedValue,
} from './types';

/** Part of `BaselineDelta`'s surface, so consumers can name the field they are handed. */
export type { VitalField } from './window';
