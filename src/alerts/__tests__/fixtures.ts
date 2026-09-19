/**
 * Shared builders for the alerts-planner tests.
 *
 * Not a test suite — `jest.config.js` requires a `.test`/`.spec` infix precisely so this file
 * can live here (see `src/risk/__tests__/fixtures.ts` for the same pattern).
 *
 * `planAlerts` only reads `RiskAssessment`/`CategoryAssessment` shapes; it never calls
 * `assessRisk`. So these builders hand-construct minimal, valid assessments directly rather than
 * running readings through the engine — the planner's tests are about the planner, not the rules
 * that produced its input.
 */

import { CATEGORY_LABELS } from '@/risk';
import type { CategoryAssessment, DataQuality, RiskAssessment, RiskCategoryKey, RiskLevel } from '@/risk';

/** Fixed reference instant. Arbitrary but constant, same convention as the risk-engine fixtures. */
export const T0 = 1_700_000_000_000;
export const MINUTE = 60 * 1000;

export type CategorySpec = {
  readonly key?: RiskCategoryKey;
  readonly level?: RiskLevel;
  readonly critical?: boolean;
  readonly dataQuality?: DataQuality;
  readonly guidance?: string;
};

/** One category assessment, defaulting to a quiet, fully-fresh green reading. */
export function category(spec: CategorySpec = {}): CategoryAssessment {
  const key = spec.key ?? 'respiratory';
  const level = spec.level ?? 'green';
  return {
    key,
    label: CATEGORY_LABELS[key],
    level,
    guidance: spec.guidance ?? 'Nothing unusual detected.',
    tier: null,
    actions: [],
    metric: '—',
    flagged: false,
    rule: null,
    firedRules: [],
    score: 0,
    envMultiplier: 1,
    critical: spec.critical ?? false,
    criticalRules: [],
    dataQuality: spec.dataQuality ?? 'ok',
  };
}

/**
 * A full assessment carrying exactly the given categories (defaults fill in the rest of the
 * six at green/ok, so a test that only cares about one category does not have to spell out
 * the other five every time).
 */
export function assessment(
  overrides: readonly CategorySpec[],
  evaluatedAt: number = T0,
): RiskAssessment {
  const byKey = new Map<RiskCategoryKey, CategorySpec>(overrides.map((spec) => [spec.key ?? 'respiratory', spec]));
  const keys: RiskCategoryKey[] = ['heat', 'respiratory', 'cardiovascular', 'fall', 'dehydration', 'fatigue'];
  const categories = keys.map((key) => category({ ...byKey.get(key), key }));

  const byCategory = Object.fromEntries(categories.map((c) => [c.key, c])) as Readonly<
    Record<RiskCategoryKey, CategoryAssessment>
  >;

  const worst = categories.reduce<RiskLevel>((acc, c) => {
    const rank: Record<RiskLevel, number> = { green: 0, amber: 1, red: 2 };
    return rank[c.level] > rank[acc] ? c.level : acc;
  }, 'green');

  const criticalRules = categories.flatMap((c) => c.criticalRules);

  return {
    level: worst,
    categories,
    byCategory,
    heatIndexC: null,
    heatIndexBand: null,
    heatIndexOutOfDomain: false,
    flaggedRules: [],
    firedRules: [],
    criticalRules,
    sosCandidate: criticalRules.length > 0,
    evaluatedAt,
    windowMs: 6 * MINUTE,
    sampleCount: 6,
  };
}
