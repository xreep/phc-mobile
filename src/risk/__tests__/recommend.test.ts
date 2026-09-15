/**
 * Tiered recommendations (PRD §7.2.4 extension) — the ladder machinery, the seven shipped
 * ladders, and the two rule overrides.
 *
 * Four separate doc comments in `src/risk/rules/` name this file as the thing that checks them
 * rather than merely asserting them in prose. Each has a section below:
 *
 *  - `recommend.ts` claims every ladder is structurally consistent and that "seven for six
 *    categories" is deliberate, cardiovascular declaring one ladder per direction.
 *  - `heat.ts` and `fall.ts` each declare a standalone {@link Recommendation} that bypasses the
 *    score, "at the tier their score would have selected anyway" — a pairing `ladderProblems`
 *    structurally cannot see, since it only ever looks at rungs.
 *  - `fall.ts` claims its three discrete scores all sit above its ladder's first rung.
 *  - `dehydration.ts` and `fatigue.ts` both claim their `ceiling` is the highest score the
 *    owning rule can emit — the property that stops a ladder advertising a tier its physiology
 *    can never reach.
 *
 * ## Why the validator is tested against broken ladders too
 * `ladderProblems` returning `[]` for seven valid ladders is exactly what `() => []` returns.
 * A validator exercised only on valid input pins nothing, so every check it makes has a case
 * below that trips it — and each asserts the problem *count*, because a check that fires twice
 * on one fault is as wrong as one that never fires.
 *
 * ## Why the ceilings are checked through `assessRisk` rather than against the constants
 * The score caps (`MAX_FATIGUE_SCORE`, `SCORE_CEILING_RISE_BPM`, `SCORE_CONFIRMED`, …) are all
 * private to their rule modules, and deliberately so. Reading them here would only prove a
 * ladder agrees with a number in the same file; driving the rule at a saturating input proves
 * it agrees with what the rule *does*. That is the direction the claim runs, and it is the one
 * that fails when a clamp is retuned and its ladder is left behind.
 */

import { assessRisk } from '../assess';
import { DEFAULT_RISK_THRESHOLDS } from '../config';
import { fahrenheitToCelsius, HEAT_INDEX_BAND_MIN_F } from '../heat-index';
import {
  BRADYCARDIA_RECOMMENDATIONS,
  TACHYCARDIA_RECOMMENDATIONS,
} from '../rules/cardiovascular';
import { DEHYDRATION_RECOMMENDATIONS } from '../rules/dehydration';
import { FALL_PENDING_RECOMMENDATION, FALL_RECOMMENDATIONS } from '../rules/fall';
import { FATIGUE_RECOMMENDATIONS } from '../rules/fatigue';
import { HEAT_COLLAPSE_RECOMMENDATION, HEAT_RECOMMENDATIONS } from '../rules/heat';
import {
  ladderProblems,
  recommend,
  tieredGuidance,
  TIER_ORDER,
  type Recommendation,
  type RecommendationLadder,
  type RecommendationRung,
} from '../rules/recommend';
import { RESPIRATORY_RECOMMENDATIONS } from '../rules/respiratory';
import { CATEGORY_LABELS, levelForScore, SCORE_BANDS } from '../rules/shared';
import type {
  EnvironmentSnapshot,
  RiskTier,
  SensorReading,
} from '../types';

import {
  activeMotion,
  at,
  healthySeries,
  impactMotion,
  MINUTE,
  reading,
  SECOND,
  series,
  stillMotion,
} from './fixtures';

const { dehydration, fatigue, heartRate } = DEFAULT_RISK_THRESHOLDS;

/**
 * Every ladder the engine ships, named as the card that carries it.
 *
 * Seven entries for six categories: cardiovascular scores upward and downward from different
 * anchors, so one ladder cannot serve both — HR 26 and HR 39 used to share a sentence, which
 * is the defect `recommend.ts`'s header opens with.
 */
const LADDERS: readonly { readonly name: string; readonly ladder: RecommendationLadder }[] = [
  { name: 'heat', ladder: HEAT_RECOMMENDATIONS },
  { name: 'respiratory', ladder: RESPIRATORY_RECOMMENDATIONS },
  { name: 'cardiovascular (tachycardia)', ladder: TACHYCARDIA_RECOMMENDATIONS },
  { name: 'cardiovascular (bradycardia)', ladder: BRADYCARDIA_RECOMMENDATIONS },
  { name: 'fall', ladder: FALL_RECOMMENDATIONS },
  { name: 'dehydration', ladder: DEHYDRATION_RECOMMENDATIONS },
  { name: 'fatigue', ladder: FATIGUE_RECOMMENDATIONS },
];

/** Both standalone recommendations, which no ladder contains and `ladderProblems` never sees. */
const OVERRIDES: readonly { readonly name: string; readonly override: Recommendation }[] = [
  { name: 'suspected heat collapse', override: HEAT_COLLAPSE_RECOMMENDATION },
  { name: 'a fall still being confirmed', override: FALL_PENDING_RECOMMENDATION },
];

/** A syntactically valid rung, so a negative test can introduce exactly one fault. */
function rung(
  minScore: number,
  tier: RiskTier,
  overrides: Partial<RecommendationRung> = {},
): RecommendationRung {
  return {
    minScore,
    tier,
    headline: `${tier} from ${minScore}`,
    actions: [`${tier} step one`, `${tier} step two`],
    ...overrides,
  };
}

function problemsFor(rungs: readonly RecommendationRung[], ceiling = 100): readonly string[] {
  return ladderProblems({ ceiling, rungs });
}

/** Environment whose heat index is exactly `heatIndexF`, so band edges are exact. */
function envAtHeatIndexF(heatIndexF: number): EnvironmentSnapshot {
  return { tempC: 30, humidity: 50, heatIndexC: fahrenheitToCelsius(heatIndexF) };
}

const COMFORTABLE: EnvironmentSnapshot = { tempC: 24, humidity: 50 };

function assess(readings: readonly SensorReading[], environment = COMFORTABLE) {
  return assessRisk({ readings, environment });
}

describe('TIER_ORDER is the only ranking', () => {
  it('runs mild → moderate → severe', () => {
    // `ladderProblems` ranks tiers with `indexOf` against this array and nothing else, so a
    // reordering here would silently invert the "does not outrank" check rather than fail it.
    expect(TIER_ORDER).toEqual(['mild', 'moderate', 'severe']);
  });

  it('names every tier any shipped rung or override uses', () => {
    const used = new Set<RiskTier>();
    for (const { ladder } of LADDERS) for (const r of ladder.rungs) used.add(r.tier);
    for (const { override } of OVERRIDES) used.add(override.tier);
    for (const tier of used) expect(TIER_ORDER).toContain(tier);
  });
});

describe('the seven shipped ladders', () => {
  it('is one per category, plus cardiovascular’s second direction', () => {
    // A seventh category added to the engine without a ladder would ship a card with no
    // guidance at all. This fails here rather than at runtime.
    expect(LADDERS).toHaveLength(Object.keys(CATEGORY_LABELS).length + 1);
  });

  for (const { name, ladder } of LADDERS) {
    it(`${name} is structurally consistent`, () => {
      expect(ladderProblems(ladder)).toEqual([]);
    });
  }

  for (const { name, ladder } of LADDERS) {
    it(`${name} keeps every rung inside one level band`, () => {
      // The property the whole design rests on: a card reading Alert may not carry mild-tier
      // advice. Asserted here as well as inside `ladderProblems`, because this is the claim a
      // reader of the ladders wants checked, not the validator's internals.
      ladder.rungs.forEach((current, index) => {
        const spanTop =
          index === ladder.rungs.length - 1 ? ladder.ceiling : ladder.rungs[index + 1].minScore - 1;
        expect(levelForScore(current.minScore)).toBe(levelForScore(spanTop));
      });
    });
  }
});

describe('ladderProblems rejects', () => {
  it('a single-rung ladder, which is the static string it replaced', () => {
    expect(problemsFor([rung(40, 'mild')], 69)).toEqual([
      expect.stringContaining('expected 2–3 tiers, found 1'),
    ]);
  });

  it('a fourth rung', () => {
    const rungs = [rung(40, 'mild'), rung(55, 'moderate'), rung(70, 'severe'), rung(90, 'severe')];
    expect(problemsFor(rungs)).toContainEqual(expect.stringContaining('found 4'));
  });

  it('an empty ladder, without then reporting faults about rungs it does not have', () => {
    expect(problemsFor([])).toHaveLength(1);
  });

  it('a first rung below the amber floor, twice over', () => {
    // The two checks cannot be separated here, and both are reported: a first rung under 40
    // starts in green, so it either crosses into amber (this case) or sits wholly in a band
    // `mild` is not allowed in. The floor check earns its place by naming the actual reason —
    // "a green card would carry a recommendation" — rather than describing the symptom.
    const rungs = [rung(SCORE_BANDS.amber.min - 1, 'mild'), rung(70, 'moderate')];
    expect(problemsFor(rungs)).toEqual([
      expect.stringContaining('below the amber floor'),
      expect.stringContaining('crossing the green/amber boundary'),
    ]);
  });

  it('a fractional floor, which would make the span arithmetic inexact', () => {
    expect(problemsFor([rung(40.5, 'mild'), rung(70, 'moderate')])).toEqual([
      expect.stringContaining('not a whole number'),
    ]);
  });

  it('a rung that does not start above the one before it', () => {
    // Also inseparable, and in the order that reads correctly: equal floors mean the earlier
    // rung's span closes before it opens, so the empty span is reported against `mild` and the
    // ordering against `moderate`. Two sentences, one fault, each pointing at its own rung.
    expect(problemsFor([rung(55, 'mild'), rung(55, 'moderate')], 69)).toEqual([
      expect.stringContaining('mild owns no scores at all (55–54)'),
      expect.stringContaining("moderate starts at 55, not above mild's 55"),
    ]);
  });

  it('a tier that does not outrank the tier below it', () => {
    // Both amber, both ascending by score — the tier rank is the only thing wrong.
    expect(problemsFor([rung(40, 'moderate'), rung(55, 'moderate')], 69)).toEqual([
      expect.stringContaining('moderate does not outrank moderate'),
    ]);
  });

  it('a rung spanning the amber/red boundary', () => {
    const rungs = [rung(40, 'mild'), rung(80, 'moderate')];
    expect(problemsFor(rungs)).toEqual([
      expect.stringContaining('crossing the amber/red boundary'),
    ]);
  });

  it('a severe rung sitting in amber', () => {
    expect(problemsFor([rung(40, 'mild'), rung(55, 'severe')], 69)).toEqual([
      expect.stringContaining('severe sits in the amber band'),
    ]);
  });

  it('a mild rung sitting in red', () => {
    expect(problemsFor([rung(70, 'mild'), rung(90, 'severe')])).toEqual([
      expect.stringContaining('mild sits in the red band'),
    ]);
  });

  it('a ceiling below the top rung', () => {
    expect(problemsFor([rung(40, 'mild'), rung(55, 'moderate')], 50)).toContainEqual(
      expect.stringContaining('must be a whole number between 55'),
    );
  });

  it('a ceiling past the top of the scale', () => {
    expect(problemsFor([rung(40, 'mild'), rung(70, 'moderate')], SCORE_BANDS.red.max + 1)).toEqual([
      expect.stringContaining('must be a whole number between'),
    ]);
  });

  it('a fractional ceiling', () => {
    expect(problemsFor([rung(40, 'mild'), rung(70, 'moderate')], 99.5)).toEqual([
      expect.stringContaining('must be a whole number between'),
    ]);
  });

  it('two rungs sharing one headline', () => {
    // The failure this whole feature exists to prevent: one sentence wearing two tier labels.
    const shared = 'Stop and rest.';
    const rungs = [
      rung(40, 'mild', { headline: shared }),
      rung(70, 'moderate', { headline: shared }),
    ];
    expect(problemsFor(rungs)).toEqual([
      expect.stringContaining("moderate repeats an earlier tier's headline"),
    ]);
  });

  it('a blank headline', () => {
    expect(problemsFor([rung(40, 'mild', { headline: '   ' }), rung(70, 'moderate')])).toEqual([
      expect.stringContaining('mild has no headline'),
    ]);
  });

  it('a rung carrying one step', () => {
    const rungs = [rung(40, 'mild', { actions: ['Only this.'] }), rung(70, 'moderate')];
    expect(problemsFor(rungs)).toEqual([expect.stringContaining('mild has 1 steps, outside 2–3')]);
  });

  it('a rung carrying four steps', () => {
    const four = ['One.', 'Two.', 'Three.', 'Four.'];
    expect(problemsFor([rung(40, 'mild', { actions: four }), rung(70, 'moderate')])).toEqual([
      expect.stringContaining('mild has 4 steps'),
    ]);
  });

  it('a blank step', () => {
    const rungs = [rung(40, 'mild', { actions: ['Drink water.', ' '] }), rung(70, 'moderate')];
    expect(problemsFor(rungs)).toEqual([expect.stringContaining('mild has an empty step')]);
  });

  it('a repeated step, which costs the rung one of its two or three chances', () => {
    const rungs = [
      rung(40, 'mild', { actions: ['Drink water.', 'Drink water.'] }),
      rung(70, 'moderate'),
    ];
    expect(problemsFor(rungs)).toEqual([expect.stringContaining('mild repeats a step')]);
  });

  it('and reports several faults at once rather than stopping at the first', () => {
    // The reason it returns a list instead of throwing: one run must describe every problem in
    // all seven ladders, not the first one it meets.
    const rungs = [
      rung(40, 'mild', { headline: '' }),
      rung(55, 'mild', { actions: ['Only this.'] }),
    ];
    expect(problemsFor(rungs, 69).length).toBeGreaterThan(2);
  });
});

describe('recommend', () => {
  for (const { name, ladder } of LADDERS) {
    it(`selects each of ${name}'s rungs exactly at its floor`, () => {
      // Identity, not equality: the rung object itself is returned, so a ladder cannot be
      // reassembled into something merely equal to it on the way out.
      ladder.rungs.forEach((expected, index) => {
        expect(recommend(ladder, expected.minScore)).toBe(expected);
        const oneBelow = index === 0 ? null : ladder.rungs[index - 1];
        expect(recommend(ladder, expected.minScore - 1)).toBe(oneBelow);
      });
    });
  }

  for (const { name, ladder } of LADDERS) {
    it(`holds ${name} at its top rung from its ceiling upward`, () => {
      const top = ladder.rungs[ladder.rungs.length - 1];
      expect(recommend(ladder, ladder.ceiling)).toBe(top);
      // `clampScore` means no shipped rule can exceed 100, so this is a guard on the export
      // rather than a reachable path — but "off the top of the ladder" must not mean "none".
      expect(recommend(ladder, 1000)).toBe(top);
    });
  }

  for (const { name, ladder } of LADDERS) {
    it(`makes no recommendation for any green ${name} score`, () => {
      for (const score of [0, 1, 20, SCORE_BANDS.green.max]) {
        expect(recommend(ladder, score)).toBeNull();
      }
    });
  }

  it('refuses a non-finite score rather than failing to the top rung', () => {
    // `NaN < 40` is false, so without the guard the loop never breaks and every ladder
    // returns its severe rung — "get medical help now" under a metric reading "—". Deleting
    // the guard turns each of these into the top rung and fails here.
    for (const { ladder } of LADDERS) {
      for (const score of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(recommend(ladder, score)).toBeNull();
      }
    }
  });

  it('treats a negative score as green rather than as an error', () => {
    expect(recommend(HEAT_RECOMMENDATIONS, -1)).toBeNull();
  });
});

describe('tieredGuidance', () => {
  const STEADY = 'Nothing unusual right now.';

  it('folds no recommendation into the rule’s own steady-state line', () => {
    expect(tieredGuidance(null, STEADY)).toEqual({
      tier: null,
      guidance: STEADY,
      actions: [],
    });
  });

  it('leaves no steps behind when there is no tier', () => {
    // `RuleOutcome` promises `actions` is empty exactly when `tier` is null. A card with steps
    // but no tier is a card whose bullet list outlived the reason for it.
    const folded = tieredGuidance(null, STEADY);
    expect(folded.actions).toHaveLength(0);
  });

  it('takes the tier, the headline, and the steps from one rung', () => {
    // The reason this is a single function rather than three ternaries at each call site.
    for (const { ladder } of LADDERS) {
      for (const expected of ladder.rungs) {
        const folded = tieredGuidance(recommend(ladder, expected.minScore), STEADY);
        expect(folded.tier).toBe(expected.tier);
        expect(folded.guidance).toBe(expected.headline);
        expect(folded.actions).toBe(expected.actions);
      }
    }
  });

  it('ignores the steady-state line once a rung is reached', () => {
    const folded = tieredGuidance(recommend(HEAT_RECOMMENDATIONS, 95), STEADY);
    expect(folded.guidance).not.toBe(STEADY);
    expect(folded.tier).toBe('severe');
  });
});

describe('the two overrides', () => {
  for (const { name, override } of OVERRIDES) {
    it(`${name} carries a rung's worth of content, which no validator checks for it`, () => {
      // `ladderProblems` only ever sees rungs, so an override is exempt from every content
      // rule by construction. These are the same limits, applied by hand.
      expect(override.headline.trim().length).toBeGreaterThan(0);
      expect(override.actions.length).toBeGreaterThanOrEqual(2);
      expect(override.actions.length).toBeLessThanOrEqual(3);
      expect(override.actions.every((action) => action.trim().length > 0)).toBe(true);
      expect(new Set(override.actions).size).toBe(override.actions.length);
      expect(TIER_ORDER).toContain(override.tier);
    });
  }

  it('says heat collapse at the tier the score would have selected anyway', () => {
    // Suspected collapse scores exactly what plain extreme heat scores — the heat index drives
    // both — so the override replaces the wording and nothing else. Pinned against the score
    // the rule actually reports, so a re-worded override cannot quietly move the tier.
    const stillMinutes = DEFAULT_RISK_THRESHOLDS.stillness.heatCriticalMs / MINUTE + 2;
    const readings = series({
      count: stillMinutes,
      everyMs: MINUTE,
      endingAt: at(0),
      hr: 72,
      spo2: 98,
    });
    const heat = assess(readings, envAtHeatIndexF(130)).byCategory.heat;

    expect(heat.criticalRules).toEqual(['heat.stillness.critical']);
    expect(heat.guidance).toBe(HEAT_COLLAPSE_RECOMMENDATION.headline);
    expect(heat.actions).toBe(HEAT_COLLAPSE_RECOMMENDATION.actions);
    expect(heat.tier).toBe(HEAT_COLLAPSE_RECOMMENDATION.tier);
    expect(recommend(HEAT_RECOMMENDATIONS, heat.score)?.tier).toBe(
      HEAT_COLLAPSE_RECOMMENDATION.tier,
    );
  });

  it('says a fall is still being confirmed at the tier the score would have selected', () => {
    // An impact one tick old, at the coarsest cadence PRD §7.2.1 allows. It scores the same as
    // an impact resolved as "no fall", because the score is a severity and "we do not know
    // yet" is not one — so the tier must still agree with that score.
    const cadence = 60 * SECOND;
    const readings: SensorReading[] = [
      reading({ at: at(-5 * MINUTE), hr: 80, spo2: 98, motionSummary: stillMotion() }),
      reading({ at: at(-2 * MINUTE), hr: 80, spo2: 98, motionSummary: stillMotion() }),
      reading({ at: at(-cadence), hr: 80, spo2: 98, motionSummary: impactMotion(3) }),
      reading({ at: at(0), hr: 80, spo2: 98, motionSummary: stillMotion() }),
    ];
    const fall = assess(readings).byCategory.fall;

    expect(fall.rule).toBe('fall.impact.unconfirmed');
    expect(fall.dataQuality).toBe('partial');
    expect(fall.guidance).toBe(FALL_PENDING_RECOMMENDATION.headline);
    expect(fall.actions).toBe(FALL_PENDING_RECOMMENDATION.actions);
    expect(fall.tier).toBe(FALL_PENDING_RECOMMENDATION.tier);
    expect(recommend(FALL_RECOMMENDATIONS, fall.score)?.tier).toBe(
      FALL_PENDING_RECOMMENDATION.tier,
    );
  });
});

/**
 * Saturating fixtures — inputs extreme enough that every ramp in the owning rule is pinned at
 * its top. Each asserts the reported score equals the ladder's declared `ceiling`, which is the
 * claim `dehydration.ts` and `fatigue.ts` both make in prose: a ceiling above what the rule can
 * emit advertises a tier the category can never deliver, and one below it hands a real score to
 * a ladder that stops short.
 */
describe('every ceiling is the highest score its rule can emit', () => {
  it('heat reaches 100 in extreme heat', () => {
    // Five minutes of stillness, well short of the ten that would make this collapse instead.
    const heat = assess(healthySeries(), envAtHeatIndexF(150)).byCategory.heat;
    expect(heat.score).toBe(HEAT_RECOMMENDATIONS.ceiling);
    expect(heat.tier).toBe('severe');
  });

  it('respiratory reaches 100 far below the critical bound', () => {
    const readings = series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 70 });
    const respiratory = assess(readings).byCategory.respiratory;
    expect(respiratory.score).toBe(RESPIRATORY_RECOMMENDATIONS.ceiling);
    expect(respiratory.tier).toBe('severe');
  });

  it('tachycardia reaches 100 once sustained at rest', () => {
    const readings = series({
      count: heartRate.sustainedForMs / MINUTE + 1,
      everyMs: MINUTE,
      endingAt: at(0),
      hr: 190,
      spo2: 98,
    });
    const cardiovascular = assess(readings).byCategory.cardiovascular;
    expect(cardiovascular.score).toBe(TACHYCARDIA_RECOMMENDATIONS.ceiling);
    expect(cardiovascular.tier).toBe('severe');
  });

  it('bradycardia reaches 100 on a single reading', () => {
    const readings = [
      ...series({ count: 5, everyMs: MINUTE, endingAt: at(-MINUTE), hr: 72, spo2: 98 }),
      reading({ at: at(0), hr: 25, spo2: 98, motionSummary: stillMotion() }),
    ];
    const cardiovascular = assess(readings).byCategory.cardiovascular;
    expect(cardiovascular.rule).toBe('cardiovascular.hr.bradycardia');
    expect(cardiovascular.score).toBe(BRADYCARDIA_RECOMMENDATIONS.ceiling);
    expect(cardiovascular.tier).toBe('severe');
  });

  it('fall reaches 100 while the person has not got up', () => {
    const fall = assess(impactThenStillness()).byCategory.fall;
    expect(fall.score).toBe(FALL_RECOMMENDATIONS.ceiling);
    expect(fall.tier).toBe('severe');
  });

  it('dehydration stops at 85, short of the band the specified flags reserve', () => {
    // Comfortably inside NOAA's Danger band, which the severe branch requires. Expressed
    // against the band rather than as a bare 110 so raising the band cannot silently drop
    // this fixture into the amber branch and fail somewhere unrelated.
    const danger = envAtHeatIndexF(HEAT_INDEX_BAND_MIN_F.danger + 7);
    const outcome = assess(driftSeries(), danger).byCategory.dehydration;
    expect(outcome.score).toBe(DEHYDRATION_RECOMMENDATIONS.ceiling);
    expect(outcome.tier).toBe('severe');
    // The containment restated where it is checked: an advisory may not outrank
    // `heat.index.extremeDanger` on the same screen, so it may not reach 90.
    expect(outcome.score).toBeLessThan(90);
    expect(outcome.flagged).toBe(false);
  });

  it('fatigue stops at 69, so it may never be red', () => {
    const outcome = assess(stillWithElevatedHr(130)).byCategory.fatigue;
    expect(outcome.score).toBe(FATIGUE_RECOMMENDATIONS.ceiling);
    expect(outcome.level).toBe('amber');
    // The other half of the argument against three global cuts: a severe rung at 90 would be
    // permanently unreachable here, so the ladder subdivides the band it can occupy instead.
    expect(outcome.tier).toBe('moderate');
    expect(levelForScore(FATIGUE_RECOMMENDATIONS.ceiling)).toBe('amber');
  });
});

describe('fall’s three discrete scores each reach a rung', () => {
  // The one category whose scores are discrete rather than interpolated, so the ladder is close
  // to a lookup table — and `fall.ts` claims all three constants sit above its first rung. Each
  // is reached through the rule, because all three are private to it.
  it('an unresolved impact selects mild', () => {
    // Past the search window with movement throughout: "moving normally" is the honest answer.
    const fall = assess(unresolvedImpact()).byCategory.fall;
    expect(fall.rule).toBe('fall.impact.unconfirmed');
    expect(fall.dataQuality).toBe('ok');
    expect(fall.tier).toBe('mild');
    expect(recommend(FALL_RECOMMENDATIONS, fall.score)?.tier).toBe('mild');
  });

  it('a confirmed fall the person got up from selects moderate', () => {
    const fall = assess(gotUpAfterFall()).byCategory.fall;
    expect(fall.rule).toBe('fall.impactThenStillness');
    // Confirmed but no longer ongoing, so it is a flag without being an SOS trigger — which
    // is exactly the distinction the middle rung exists to say out loud.
    expect(fall.flagged).toBe(true);
    expect(fall.criticalRules).toEqual([]);
    expect(fall.tier).toBe('moderate');
    expect(recommend(FALL_RECOMMENDATIONS, fall.score)?.tier).toBe('moderate');
  });

  it('a fall with the person still down selects severe', () => {
    const fall = assess(impactThenStillness()).byCategory.fall;
    expect(fall.criticalRules).toEqual(['fall.impactThenStillness']);
    expect(fall.tier).toBe('severe');
    expect(recommend(FALL_RECOMMENDATIONS, fall.score)?.tier).toBe('severe');
  });

  it('reaches all three rungs, so none of them is decoration', () => {
    // Three constants, three rungs, three distinct tiers. A ladder whose middle rung no score
    // can land on is a tier the user will never be told about, and the count alone would not
    // notice — `ladderProblems` checks that the rungs are well-formed, not that they are used.
    const scores = [
      assess(unresolvedImpact()).byCategory.fall.score,
      assess(gotUpAfterFall()).byCategory.fall.score,
      assess(impactThenStillness()).byCategory.fall.score,
    ];
    const tiers = scores.map((score) => recommend(FALL_RECOMMENDATIONS, score)?.tier);
    expect(tiers).toEqual(['mild', 'moderate', 'severe']);
    expect(new Set(scores).size).toBe(FALL_RECOMMENDATIONS.rungs.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Saturating fixtures
// ---------------------------------------------------------------------------------------------

/** An impact five minutes back, then stillness through to now — a fall still in progress. */
function impactThenStillness(cadenceMs = 60 * SECOND): SensorReading[] {
  const impactAt = at(-5 * MINUTE);
  const readings: SensorReading[] = [
    reading({ at: impactAt, hr: 80, spo2: 98, motionSummary: impactMotion(3) }),
  ];
  for (let t = impactAt + cadenceMs; t <= at(0); t += cadenceMs) {
    readings.push(reading({ at: t, hr: 80, spo2: 98, motionSummary: stillMotion() }));
  }
  return readings;
}

/**
 * An impact, then enough stillness to confirm it, then movement — the person got up.
 *
 * The stillness sits inside `fall.stillnessWindowMs` of the impact so the search confirms it,
 * and the newest readings are active so the trailing still run is empty. That pair is the
 * whole difference between the moderate rung and the severe one.
 */
function gotUpAfterFall(): SensorReading[] {
  return [
    reading({ at: at(-5 * MINUTE), hr: 80, spo2: 98, motionSummary: impactMotion(3) }),
    reading({ at: at(-4 * MINUTE), hr: 80, spo2: 98, motionSummary: stillMotion() }),
    reading({ at: at(-3 * MINUTE), hr: 80, spo2: 98, motionSummary: stillMotion() }),
    ...[2, 1, 0].map((n) =>
      reading({ at: at(-n * MINUTE), hr: 80, spo2: 98, motionSummary: activeMotion(1.8) }),
    ),
  ];
}

/** An impact old enough that its search window has closed, with movement ever since. */
function unresolvedImpact(): SensorReading[] {
  return [
    reading({ at: at(-8 * MINUTE), hr: 80, spo2: 98, motionSummary: impactMotion(3) }),
    ...[6, 4, 2, 0].map((n) =>
      reading({ at: at(-n * MINUTE), hr: 80, spo2: 98, motionSummary: activeMotion(1.8) }),
    ),
  ];
}

/**
 * A full dehydration window: a resting baseline, then a drift far past the severe rise.
 *
 * The elevation is confined to the newest 55 % of the window, which sits inside the newest
 * 60 % the drift slice occupies at this cadence. That matters: an elevation reaching into the
 * oldest 40 % would raise the baseline it is measured against, and the *rise* — not the heart
 * rate — is what the score interpolates, so a polluted baseline would land below the ceiling
 * for reasons that have nothing to do with the clamp under test.
 */
function driftSeries(cadenceMs = 30 * SECOND): SensorReading[] {
  const driftMs = dehydration.windowMs * 0.55;
  const readings: SensorReading[] = [];
  for (let offset = 0; offset < dehydration.windowMs; offset += cadenceMs) {
    readings.push(
      reading({
        at: at(-offset),
        hr: offset < driftMs ? 120 : 70,
        spo2: 98,
        motionSummary: stillMotion(),
      }),
    );
  }
  return readings.reverse();
}

/** A full fatigue window: motionless throughout, heart rate pinned above the ramp's ceiling. */
function stillWithElevatedHr(hr: number, cadenceMs = 60 * SECOND): SensorReading[] {
  const readings: SensorReading[] = [];
  for (let offset = 0; offset < fatigue.windowMs; offset += cadenceMs) {
    readings.push(reading({ at: at(-offset), hr, spo2: 98, motionSummary: stillMotion() }));
  }
  return readings.reverse();
}
