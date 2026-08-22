/**
 * Tier-1 assessment entry point (PRD §7.2.2).
 *
 * `assessRisk` is a pure function: same input, same output, no clock, no I/O, no
 * module state. That is what lets the whole engine be unit-tested without a device,
 * and it is also what lets the sensor pipeline call it on every tick without worrying
 * about accumulated state drifting out of sync with the buffer.
 *
 * This file deliberately contains no physiology. It resolves the window, resolves the
 * heat index once, runs the four rules, and merges their outcomes. Every threshold and
 * every clinical decision lives in `config.ts` and `rules/`.
 */

import { resolveRiskThresholds } from './config';
import type {
  CategoryAssessment,
  RiskAssessment,
  RiskAssessmentInput,
  RiskCategoryKey,
  RiskLevel,
  RuleId,
} from './types';
import { SPEC_FLAG_RULES } from './types';
import { sortByTimestamp, withinWindow } from './window';
import { assessCardiovascular } from './rules/cardiovascular';
import { assessFall } from './rules/fall';
import { assessHeat, resolveHeatIndex } from './rules/heat';
import { assessRespiratory } from './rules/respiratory';
import { CATEGORY_LABELS, type RuleContext, type RuleOutcome } from './rules/shared';

/** Severity order for merging. Not exported — nothing outside should rank levels. */
const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = { green: 0, amber: 1, red: 2 };

/** Dashboard order, matching `RISK_CATEGORIES` so this is a drop-in replacement. */
const CATEGORY_ORDER: readonly RiskCategoryKey[] = [
  'heat',
  'respiratory',
  'cardiovascular',
  'fall',
];

const SPEC_FLAG_SET = new Set<RuleId>(SPEC_FLAG_RULES);

function worstLevel(levels: readonly RiskLevel[]): RiskLevel {
  return levels.reduce<RiskLevel>(
    (worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst),
    'green',
  );
}

function toCategory(key: RiskCategoryKey, outcome: RuleOutcome): CategoryAssessment {
  return {
    key,
    label: CATEGORY_LABELS[key],
    level: outcome.level,
    guidance: outcome.guidance,
    metric: outcome.metric,
    flagged: outcome.flagged,
    rule: outcome.rule,
    firedRules: outcome.firedRules,
    score: outcome.score,
    envMultiplier: outcome.envMultiplier,
    critical: outcome.criticalRules.length > 0,
    criticalRules: outcome.criticalRules,
    dataQuality: outcome.dataQuality,
  };
}

/**
 * Evaluation instant.
 *
 * Falls back to the newest reading rather than a clock, because reading a clock here
 * would make the function impure and every duration rule untestable without fake
 * timers. Callers in the app pass `Date.now()` explicitly.
 */
function resolveNow(input: RiskAssessmentInput, sorted: readonly { timestamp: number }[]): number {
  if (input.now !== undefined && Number.isFinite(input.now)) return input.now;
  if (sorted.length > 0) return sorted[sorted.length - 1].timestamp;
  const observedAt = input.environment?.observedAt;
  if (observedAt !== undefined && Number.isFinite(observedAt)) return observedAt;
  return 0;
}

export function assessRisk(input: RiskAssessmentInput): RiskAssessment {
  const thresholds = resolveRiskThresholds(input.thresholds);
  const sorted = sortByTimestamp(input.readings ?? []);
  const now = resolveNow(input, sorted);

  // One clamp per lookback. The long one exists solely for PRD §7.2.5's ten-minute
  // stillness; handing it to the vitals rules would let a nine-minute-old heart rate
  // count as current.
  //
  // `heatCriticalMs` gets a `maxGapMs` of headroom for the same reason the tachycardia
  // window does: the lookback is half-open, so a window exactly `heatCriticalMs` wide
  // can only ever hold a span strictly less than it, and the rule's `> heatCriticalMs`
  // test would be unsatisfiable — silently, with no error anywhere.
  const longestLookbackMs = Math.max(
    thresholds.window.ms,
    thresholds.stillness.heatCriticalMs + thresholds.window.maxGapMs,
    thresholds.fall.stillnessWindowMs,
  );
  const extendedReadings = withinWindow(sorted, now, longestLookbackMs);
  const readings = withinWindow(sorted, now, thresholds.window.ms);

  const environment = input.environment ?? null;
  const heat = resolveHeatIndex(environment);

  const context: RuleContext = {
    readings,
    extendedReadings,
    environment,
    now,
    thresholds,
    heatIndexF: heat.heatIndexF,
    heatIndexBand: heat.band,
    heatIndexOutOfDomain: heat.outOfDomain,
  };

  const outcomes: Readonly<Record<RiskCategoryKey, RuleOutcome>> = {
    heat: assessHeat(context),
    respiratory: assessRespiratory(context),
    cardiovascular: assessCardiovascular(context),
    fall: assessFall(context),
  };

  const categories = CATEGORY_ORDER.map((key) => toCategory(key, outcomes[key]));

  // `Object.fromEntries` would type this as a partial record, so it is built by
  // reduction over the exhaustive key list instead — a missing category becomes a
  // compile error rather than an `undefined` the UI has to guard.
  const byCategory = CATEGORY_ORDER.reduce(
    (accumulator, key, index) => {
      accumulator[key] = categories[index];
      return accumulator;
    },
    {} as Record<RiskCategoryKey, CategoryAssessment>,
  );

  const firedRules = categories.flatMap((category) => category.firedRules);
  const criticalRules = categories.flatMap((category) => category.criticalRules);

  return {
    level: worstLevel(categories.map((category) => category.level)),
    categories,
    byCategory,
    heatIndexC: heat.heatIndexC,
    heatIndexBand: heat.band,
    heatIndexOutOfDomain: heat.outOfDomain,
    flaggedRules: firedRules.filter((rule) => SPEC_FLAG_SET.has(rule)),
    firedRules,
    criticalRules,
    sosCandidate: criticalRules.length > 0,
    evaluatedAt: now,
    windowMs: thresholds.window.ms,
    sampleCount: readings.length,
  };
}
