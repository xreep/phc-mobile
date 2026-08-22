/**
 * Shared contract for the four Tier-1 rules (PRD §7.2.2).
 *
 * Each rule is a pure `(RuleContext) => RuleOutcome`. Keeping them uniform is what
 * lets `assess.ts` stay a thin fold: it builds the context once, runs the rules, and
 * merges their outcomes without knowing anything about physiology.
 */

import type { HeatIndexBand } from '../heat-index';
import type {
  DataQuality,
  EnvironmentSnapshot,
  RiskCategoryKey,
  RiskLevel,
  RuleId,
  RiskThresholds,
  SensorReading,
} from '../types';

/** Card titles, matching `RISK_CATEGORIES` exactly so the Dashboard is unchanged. */
export const CATEGORY_LABELS: Readonly<Record<RiskCategoryKey, string>> = {
  heat: 'Heat Stress',
  respiratory: 'Respiratory',
  cardiovascular: 'Cardiovascular',
  fall: 'Fall Detection',
};

/**
 * Everything a rule may read. Assembled once per tick by `assess.ts`.
 *
 * Two separate reading sets, deliberately. `readings` is the short vitals window
 * (minutes); `extendedReadings` reaches back far enough for PRD §7.2.5's "no motion
 * for > 10 min". Handing every rule the long buffer would silently stretch the vitals
 * rules' notion of "now" — a heart rate from nine minutes ago is not current — so the
 * two lookbacks stay explicit and a rule opts into the long one only if it needs it.
 */
export type RuleContext = {
  /** In-window, ascending, timestamps validated. */
  readonly readings: readonly SensorReading[];
  /** Longest lookback any rule needs, ascending. Superset of `readings`. */
  readonly extendedReadings: readonly SensorReading[];
  readonly environment: EnvironmentSnapshot | null;
  readonly now: number;
  readonly thresholds: RiskThresholds;
  /** Heat index in °F — the unit every band comparison is made in. `null` when no
   *  environment snapshot was supplied. */
  readonly heatIndexF: number | null;
  readonly heatIndexBand: HeatIndexBand | null;
  readonly heatIndexOutOfDomain: boolean;
};

/** A rule's verdict for its category. */
export type RuleOutcome = {
  readonly level: RiskLevel;
  /** A PRD §7.2.2 Tier-1 flag fired. Never set by advisory precursors. */
  readonly flagged: boolean;
  /** Highest-severity rule that fired, or `null`. */
  readonly rule: RuleId | null;
  /** All rules that fired, severity-descending. */
  readonly firedRules: readonly RuleId[];
  /** PRD §7.2.5 triggers among them. */
  readonly criticalRules: readonly RuleId[];
  readonly score: number;
  /** Short current-reading string for the card's third line. */
  readonly metric: string;
  /** One-line, plain-language action (PRD §7.2.4). */
  readonly guidance: string;
  readonly dataQuality: DataQuality;
  readonly envMultiplier: number;
};

/**
 * Score bands, shared by all four rules so a 0–100 number means the same thing in
 * every category and the later ML layer (PRD §7.2.2 emits 0–100 too) can be fused
 * against them on one scale.
 *
 * `level` is derived from these bands, never assigned independently — otherwise a
 * rule could report `red` with a score of 12 and the fusion layer would disagree with
 * the card the user is looking at.
 */
export const SCORE_BANDS = {
  green: { min: 0, max: 39 },
  amber: { min: 40, max: 69 },
  red: { min: 70, max: 100 },
} as const;

/** Band a score falls in. The single place score→level is decided. */
export function levelForScore(score: number): RiskLevel {
  if (score >= SCORE_BANDS.red.min) return 'red';
  if (score >= SCORE_BANDS.amber.min) return 'amber';
  return 'green';
}

/**
 * Map `value` from `[fromValue, toValue]` onto `[fromScore, toScore]`, clamped to the
 * score endpoints. `fromValue` may be greater than `toValue` — the SpO₂ and heart-rate
 * scales both run downward — so the direction is taken from the arguments.
 */
export function interpolateScore(
  value: number,
  fromValue: number,
  toValue: number,
  fromScore: number,
  toScore: number,
): number {
  const span = toValue - fromValue;
  // A zero-width input span has no meaningful interpolation; treat as fully advanced
  // so a degenerate config fails toward the higher score rather than reporting 0.
  const ratio = span === 0 ? 1 : (value - fromValue) / span;
  const clamped = Math.min(1, Math.max(0, ratio));
  return fromScore + clamped * (toScore - fromScore);
}

/** Clamp into the reportable range. Scores are compared, not displayed, so they are
 *  not rounded — rounding could nudge a value across a band edge. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

/** Convenience for the common "nothing to assess" outcome. Green, but honest about
 *  why: `dataQuality` carries the difference between "fine" and "unknown". */
export function unknownOutcome(
  guidance: string,
  metric: string,
  dataQuality: DataQuality = 'missing',
): RuleOutcome {
  return {
    level: 'green',
    flagged: false,
    rule: null,
    firedRules: [],
    criticalRules: [],
    score: 0,
    metric,
    guidance,
    dataQuality,
    envMultiplier: 1,
  };
}
