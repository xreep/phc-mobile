/**
 * Air-quality advisory in the respiratory rule (PS 26181 §3b; PRD §7.2.3 / §7.2.4 ext).
 *
 * The three `respiratory.aqi.*` rules are **advisory precursors** in the sense
 * `heat.index.extremeCaution` established: they move the card's level, score, and guidance and
 * they appear in `firedRules`, but they never set `flagged`, never appear in `criticalRules`,
 * and never make the assessment an SOS candidate. Only SpO₂ can do those things, exactly as
 * before. Every test in the "never a flag" block below is the thing that keeps that true.
 *
 * ## How numbers are used here
 * The EPA band edges — 150, 200, 300 — are pinned as literals, the way `assess.test.ts` pins
 * the PRD §7.2.2 thresholds: they come from airnow.gov's published table, not from tuning, so a
 * config edit that drifts from them must fail here. The advisory *scores* are read from
 * `DEFAULT_RISK_THRESHOLDS.env` because those are derived and expected to be retuned; the test
 * that matters for them is that each default lands on the ladder rung whose wording names its
 * band.
 *
 * ## The byte-identical block
 * The literals in `PRE_CHANGE` were captured by running the engine on these exact fixtures
 * *before* the advisory existed. They are not derived from the code under test, so they cannot
 * drift with it — if a refactor changes the respiratory outcome for an input with no usable AQI,
 * this is the block that says so.
 */

import { aqiCategoryFor } from '@/environment/aqi';

import { AQI_BAND_MAX, aqiBandLabelFor } from '../aqi-bands';
import { assessRisk } from '../assess';
import { DEFAULT_RISK_THRESHOLDS, resolveRiskThresholds } from '../config';
import { RESPIRATORY_AQI_RECOMMENDATIONS, RESPIRATORY_RECOMMENDATIONS } from '../rules/respiratory';
import { levelForScore, SCORE_BANDS } from '../rules/shared';
import type { CategoryAssessment, EnvironmentSnapshot, RiskAssessment, SensorReading } from '../types';
import { CRITICAL_RULES, SPEC_FLAG_RULES } from '../types';

import { at, healthySeries, MINUTE, series } from './fixtures';

const { env } = DEFAULT_RISK_THRESHOLDS;

/** Heat index well inside NOAA's Normal band, so heat stays out of the way. */
const COMFORTABLE: EnvironmentSnapshot = { tempC: 24, humidity: 50 };

/** A fresh observation: ten minutes old, comfortably inside `env.maxStaleMs` (60 min). */
const FRESH_OBSERVED_AT = at(-10 * MINUTE);

function polluted(aqi: number, observedAt: number = FRESH_OBSERVED_AT): EnvironmentSnapshot {
  return { ...COMFORTABLE, aqi, observedAt };
}

function assess(readings: readonly SensorReading[], environment: EnvironmentSnapshot): RiskAssessment {
  return assessRisk({ readings, environment, now: at(0) });
}

function respiratory(readings: readonly SensorReading[], environment: EnvironmentSnapshot): CategoryAssessment {
  return assess(readings, environment).byCategory.respiratory;
}

/** Six minutes of readings at one SpO₂, one per minute, otherwise healthy. */
function spo2Series(spo2: number): SensorReading[] {
  return series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2 });
}

const [UNHEALTHY_RUNG, VERY_UNHEALTHY_RUNG, HAZARDOUS_RUNG] = RESPIRATORY_AQI_RECOMMENDATIONS.rungs;

describe('the EPA band edges and the general-population line have not drifted', () => {
  it('pins the advisory line at the top of "Unhealthy for Sensitive Groups"', () => {
    // 150 is where EPA's cautionary statement stops being addressed to sensitive groups only
    // and starts being addressed to everyone. Below it the general population gets no level
    // change — vulnerable-group personalisation is a later milestone, and it will lower this
    // number for those users rather than move the bands.
    expect(env.aqiAdvisoryAbove).toBe(150);
  });

  it('pins the band table to airnow.gov', () => {
    expect(AQI_BAND_MAX).toEqual({ unhealthy: 200, veryUnhealthy: 300 });
  });

  it('pins the three advisory scores to their level bands', () => {
    expect(env.aqiUnhealthyScore).toBe(40);
    expect(env.aqiVeryUnhealthyScore).toBe(55);
    expect(env.aqiHazardousScore).toBe(70);
    expect(levelForScore(env.aqiUnhealthyScore)).toBe('amber');
    expect(levelForScore(env.aqiVeryUnhealthyScore)).toBe('amber');
    // Hazardous reaching red is deliberate: EPA calls it "emergency conditions". It is still
    // not a flag — see the "never a flag" block.
    expect(levelForScore(env.aqiHazardousScore)).toBe('red');
  });

  it('lands each default score on the rung whose wording names its band', () => {
    // The ladder is static and the scores are config, so this is the only thing stopping a
    // retune from printing "very unhealthy" under an AQI of 168.
    expect(UNHEALTHY_RUNG.minScore).toBe(env.aqiUnhealthyScore);
    expect(VERY_UNHEALTHY_RUNG.minScore).toBe(env.aqiVeryUnhealthyScore);
    expect(HAZARDOUS_RUNG.minScore).toBe(env.aqiHazardousScore);
  });
});

describe('the engine-local band labels agree with the environment module', () => {
  // `src/environment/aqi.ts` owns the EPA table for the Environment screen. The engine keeps
  // its own two edges rather than importing that module, because `src/risk` imports nothing
  // but types from the app (see the header of `src/risk/index.ts`). This test is what stops
  // the two copies drifting apart.
  const PROBES = [0, 50, 51, 100, 101, 150, 151, 175, 200, 201, 250, 300, 301, 400, 500, 999];

  for (const aqi of PROBES) {
    it(`labels AQI ${aqi} as the environment module does`, () => {
      expect(aqiBandLabelFor(aqi)).toBe(aqiCategoryFor(aqi).label);
    });
  }
});

describe('band boundaries (strict "above" at 150, inclusive tops at 200 and 300)', () => {
  const CASES: readonly (readonly [number, string | null])[] = [
    [150, null],
    [151, 'respiratory.aqi.unhealthy'],
    [200, 'respiratory.aqi.unhealthy'],
    [201, 'respiratory.aqi.veryUnhealthy'],
    [300, 'respiratory.aqi.veryUnhealthy'],
    [301, 'respiratory.aqi.hazardous'],
  ];

  for (const [aqi, rule] of CASES) {
    it(`AQI ${aqi} → ${rule ?? 'no advisory'}`, () => {
      expect(respiratory(healthySeries(), polluted(aqi)).rule).toBe(rule);
    });
  }

  it('scores each band at its configured advisory score', () => {
    expect(respiratory(healthySeries(), polluted(151)).score).toBe(env.aqiUnhealthyScore);
    expect(respiratory(healthySeries(), polluted(201)).score).toBe(env.aqiVeryUnhealthyScore);
    expect(respiratory(healthySeries(), polluted(301)).score).toBe(env.aqiHazardousScore);
  });
});

describe('AQI 168 with normal SpO₂ — the fixture the screens render', () => {
  const result = assess(healthySeries(), polluted(168));
  const category = result.byCategory.respiratory;

  it('turns the card amber on the Unhealthy advisory', () => {
    expect(category.level).toBe('amber');
    expect(category.rule).toBe('respiratory.aqi.unhealthy');
    expect(category.firedRules).toEqual(['respiratory.aqi.unhealthy']);
    expect(category.score).toBe(env.aqiUnhealthyScore);
  });

  it('is advisory only — no flag, no critical, no SOS', () => {
    expect(category.flagged).toBe(false);
    expect(category.critical).toBe(false);
    expect(category.criticalRules).toEqual([]);
    expect(result.flaggedRules).toEqual([]);
    expect(result.criticalRules).toEqual([]);
    expect(result.sosCandidate).toBe(false);
  });

  it('is nonetheless a fired rule at the top level', () => {
    expect(result.firedRules).toContain('respiratory.aqi.unhealthy');
  });

  it('appends the AQI and its EPA label to the metric line', () => {
    expect(category.metric).toBe('SpO₂ 98% · AQI 168 (Unhealthy)');
  });

  it('selects the mild rung of the air-quality ladder', () => {
    expect(category.tier).toBe('mild');
    expect(category.guidance).toBe(UNHEALTHY_RUNG.headline);
    expect(category.actions).toEqual(UNHEALTHY_RUNG.actions);
  });

  it('leaves the multiplier exactly where it was', () => {
    // Reported, never applied — the advisory is a separate mechanism from the multiplier, and
    // `envMultiplier` must not move because the level did.
    expect(category.envMultiplier).toBeCloseTo(1 + (68 / 200) * 0.3, 10);
    expect(category.dataQuality).toBe('ok');
  });
});

describe('the advisory raises the score, never lowers it', () => {
  it('lifts a green-but-declining SpO₂ to the advisory score', () => {
    // SpO₂ 93 % scores about 31 — green with a gradient. The advisory owns the card at 40.
    const clean = respiratory(spo2Series(93), COMFORTABLE);
    const dirty = respiratory(spo2Series(93), polluted(168));
    expect(clean.score).toBeGreaterThan(0);
    expect(clean.score).toBeLessThan(env.aqiUnhealthyScore);
    expect(dirty.score).toBe(env.aqiUnhealthyScore);
    expect(dirty.rule).toBe('respiratory.aqi.unhealthy');
    expect(dirty.tier).toBe('mild');
  });

  it('keeps a flagged SpO₂ score when the air is merely unhealthy', () => {
    const clean = respiratory(spo2Series(90), COMFORTABLE);
    const dirty = respiratory(spo2Series(90), polluted(168));
    expect(dirty.score).toBe(clean.score);
    expect(dirty.level).toBe('red');
  });
});

describe('combination with SpO₂ — SpO₂ rules first, the advisory after', () => {
  it('critical still wins over Unhealthy air, in severity order', () => {
    const critical = series({ count: 2, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 84 });
    const result = assess(critical, polluted(168));
    const category = result.byCategory.respiratory;

    expect(category.firedRules).toEqual([
      'respiratory.spo2.critical',
      'respiratory.spo2.low',
      'respiratory.aqi.unhealthy',
    ]);
    expect(category.rule).toBe('respiratory.spo2.critical');
    expect(category.level).toBe('red');
    expect(category.flagged).toBe(true);
    expect(category.critical).toBe(true);
    expect(category.criticalRules).toEqual(['respiratory.spo2.critical']);
    expect(result.sosCandidate).toBe(true);
    // Guidance follows the driver: the SpO₂ ladder's severe rung, not the air-quality one.
    expect(category.tier).toBe('severe');
    expect(category.guidance).toBe(RESPIRATORY_RECOMMENDATIONS.rungs[1].headline);
    // The advisory is still visible on the metric line, so the reader sees both.
    expect(category.metric).toBe('SpO₂ 84% · AQI 168 (Unhealthy)');
  });

  it('a low SpO₂ outranks hazardous air even when both sit at the floor of red', () => {
    // SpO₂ just under 92 % scores a hair over 70 (the flag's floor); Hazardous scores exactly
    // 70. Ordering is by severity class, not by score — the PRD flag must be `rule`, and a
    // flag never sits behind an advisory.
    const flagged = series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 91.99 });
    const category = respiratory(flagged, polluted(350));
    expect(category.firedRules).toEqual(['respiratory.spo2.low', 'respiratory.aqi.hazardous']);
    expect(category.rule).toBe('respiratory.spo2.low');
    expect(category.flagged).toBe(true);
    expect(category.tier).toBe('moderate');
    expect(category.guidance).toBe(RESPIRATORY_RECOMMENDATIONS.rungs[0].headline);
  });
});

describe('AQI 350 — Hazardous reaches red and is still not a flag', () => {
  const result = assess(healthySeries(), polluted(350));
  const category = result.byCategory.respiratory;

  it('is red at the configured hazardous score', () => {
    expect(category.level).toBe('red');
    expect(category.score).toBe(env.aqiHazardousScore);
    expect(category.rule).toBe('respiratory.aqi.hazardous');
    expect(category.tier).toBe('severe');
    expect(category.guidance).toBe(HAZARDOUS_RUNG.headline);
    expect(category.metric).toBe('SpO₂ 98% · AQI 350 (Hazardous)');
  });

  it('does not flag, escalate, or reach the flagged list', () => {
    expect(category.flagged).toBe(false);
    expect(category.critical).toBe(false);
    expect(result.flaggedRules).toEqual([]);
    expect(result.sosCandidate).toBe(false);
  });

  it('rolls the top-level level up to red like any other category would', () => {
    expect(result.level).toBe('red');
  });
});

describe('Very Unhealthy sits between the two', () => {
  it('is amber at the middle rung', () => {
    const category = respiratory(healthySeries(), polluted(250));
    expect(category.level).toBe('amber');
    expect(category.rule).toBe('respiratory.aqi.veryUnhealthy');
    expect(category.tier).toBe('moderate');
    expect(category.guidance).toBe(VERY_UNHEALTHY_RUNG.headline);
    expect(category.metric).toBe('SpO₂ 98% · AQI 250 (Very Unhealthy)');
  });
});

describe('no usable SpO₂ but an advisory — the card must not stay silent green', () => {
  it('returns the advisory with partial data quality on an empty buffer', () => {
    const category = respiratory([], polluted(250));
    expect(category.level).toBe('amber');
    expect(category.rule).toBe('respiratory.aqi.veryUnhealthy');
    expect(category.score).toBe(env.aqiVeryUnhealthyScore);
    expect(category.dataQuality).toBe('partial');
    expect(category.metric).toBe('SpO₂ — · AQI 250 (Very Unhealthy)');
    expect(category.tier).toBe('moderate');
    expect(category.guidance).toBe(VERY_UNHEALTHY_RUNG.headline);
    expect(category.flagged).toBe(false);
    expect(category.criticalRules).toEqual([]);
  });

  it('does the same when the readings carry no SpO₂ field at all', () => {
    const noSpo2 = series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72 });
    const category = respiratory(noSpo2, polluted(168));
    expect(category.rule).toBe('respiratory.aqi.unhealthy');
    expect(category.dataQuality).toBe('partial');
    expect(category.metric).toBe('SpO₂ — · AQI 168 (Unhealthy)');
  });

  it('keeps reporting the multiplier alongside', () => {
    expect(respiratory([], polluted(250)).envMultiplier).toBeCloseTo(1 + (150 / 200) * 0.3, 10);
  });

  it('still reports missing when there is no advisory either', () => {
    const category = respiratory([], polluted(120));
    expect(category.dataQuality).toBe('missing');
    expect(category.rule).toBeNull();
    expect(category.metric).toBe('SpO₂ —');
  });
});

describe('staleness — the advisory applies only to a current observation', () => {
  it('fires at exactly the staleness bound and not one millisecond past it', () => {
    const atBound = respiratory(healthySeries(), polluted(168, at(-env.maxStaleMs)));
    const pastBound = respiratory(healthySeries(), polluted(168, at(-env.maxStaleMs - 1)));
    expect(atBound.rule).toBe('respiratory.aqi.unhealthy');
    expect(pastBound.rule).toBeNull();
    expect(pastBound.level).toBe('green');
    expect(pastBound.metric).toBe('SpO₂ 98%');
  });

  it('treats an observation with no timestamp as current, exactly as heat does', () => {
    // `EnvironmentSnapshot.observedAt` is optional and the heat rule reads its absence as
    // "not stale". The two rules must agree, or one weather snapshot would be fresh enough
    // for a heat flag and too old for an air-quality advisory.
    const category = respiratory(healthySeries(), { ...COMFORTABLE, aqi: 168 });
    expect(category.rule).toBe('respiratory.aqi.unhealthy');
  });

  it('is decided on the environment clock, not the vitals clock', () => {
    // 20 minutes is well past `window.maxStaleMs` (3 min) and well inside `env.maxStaleMs`.
    const category = respiratory(healthySeries(), polluted(168, at(-20 * MINUTE)));
    expect(category.rule).toBe('respiratory.aqi.unhealthy');
    expect(category.dataQuality).toBe('ok');
  });

  it('keeps the SpO₂ staleness verdict when the advisory is what drives the card', () => {
    // Old vitals plus current hazardous air: the level follows the air, but `dataQuality`
    // still says the SpO₂ behind the metric is out of date.
    const result = assessRisk({
      readings: healthySeries(at(-5 * MINUTE)),
      environment: polluted(350),
      now: at(0),
    });
    const category = result.byCategory.respiratory;
    expect(category.rule).toBe('respiratory.aqi.hazardous');
    expect(category.dataQuality).toBe('stale');
  });
});

describe('inputs that must produce no advisory', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5])(
    'ignores an unusable AQI of %p',
    (aqi) => {
      const category = respiratory(healthySeries(), polluted(aqi));
      expect(category.rule).toBeNull();
      expect(category.metric).toBe('SpO₂ 98%');
    },
  );

  it('does nothing without an environment at all', () => {
    expect(assessRisk({ readings: healthySeries(), now: at(0) }).byCategory.respiratory.rule).toBeNull();
  });
});

describe('unchanged behaviour when there is no advisory (byte-identical to pre-change output)', () => {
  // Captured before the advisory existed. See the file header.
  const PRE_CHANGE = {
    healthyNoAqi: {
      key: 'respiratory',
      label: 'Respiratory',
      level: 'green',
      guidance: 'Blood oxygen is in the normal range.',
      tier: null,
      actions: [],
      metric: 'SpO₂ 98%',
      flagged: false,
      rule: null,
      firedRules: [],
      score: 0,
      envMultiplier: 1,
      critical: false,
      criticalRules: [],
      dataQuality: 'ok',
    },
    lowSpo2NoAqi: {
      key: 'respiratory',
      label: 'Respiratory',
      level: 'red',
      guidance: 'Blood oxygen is below normal — sit upright, rest, and breathe slowly.',
      tier: 'moderate',
      actions: [
        'Sit upright and stop what you are doing.',
        'Breathe slowly through your nose for a few minutes.',
        'Get medical advice if it does not come back up.',
      ],
      metric: 'SpO₂ 90%',
      flagged: true,
      rule: 'respiratory.spo2.low',
      firedRules: ['respiratory.spo2.low'],
      score: 75.42857142857143,
      envMultiplier: 1,
      critical: false,
      criticalRules: [],
      dataQuality: 'ok',
    },
    emptyNoAqi: {
      key: 'respiratory',
      label: 'Respiratory',
      level: 'green',
      guidance: 'No recent blood-oxygen reading.',
      tier: null,
      actions: [],
      metric: 'SpO₂ —',
      flagged: false,
      rule: null,
      firedRules: [],
      score: 0,
      envMultiplier: 1,
      critical: false,
      criticalRules: [],
      dataQuality: 'missing',
    },
    healthyAqiBelowLine: {
      key: 'respiratory',
      label: 'Respiratory',
      level: 'green',
      guidance: 'Blood oxygen is in the normal range.',
      tier: null,
      actions: [],
      metric: 'SpO₂ 98%',
      flagged: false,
      rule: null,
      firedRules: [],
      score: 0,
      envMultiplier: 1.075,
      critical: false,
      criticalRules: [],
      dataQuality: 'ok',
    },
    healthyStaleAqi: {
      key: 'respiratory',
      label: 'Respiratory',
      level: 'green',
      guidance: 'Blood oxygen is in the normal range.',
      tier: null,
      actions: [],
      metric: 'SpO₂ 98%',
      flagged: false,
      rule: null,
      firedRules: [],
      score: 0,
      envMultiplier: 1.102,
      critical: false,
      criticalRules: [],
      dataQuality: 'ok',
    },
    noEnv: {
      key: 'respiratory',
      label: 'Respiratory',
      level: 'green',
      guidance: 'Blood oxygen is in the normal range.',
      tier: null,
      actions: [],
      metric: 'SpO₂ 98%',
      flagged: false,
      rule: null,
      firedRules: [],
      score: 0,
      envMultiplier: 1,
      critical: false,
      criticalRules: [],
      dataQuality: 'ok',
    },
  } as const;

  it('healthy readings, no aqi field', () => {
    expect(assessRisk({ readings: healthySeries(), environment: COMFORTABLE }).byCategory.respiratory)
      .toStrictEqual(PRE_CHANGE.healthyNoAqi);
  });

  it('flagged SpO₂, no aqi field', () => {
    expect(assessRisk({ readings: spo2Series(90), environment: COMFORTABLE }).byCategory.respiratory)
      .toStrictEqual(PRE_CHANGE.lowSpo2NoAqi);
  });

  it('empty buffer, no aqi field', () => {
    expect(assessRisk({ readings: [], environment: COMFORTABLE, now: at(0) }).byCategory.respiratory)
      .toStrictEqual(PRE_CHANGE.emptyNoAqi);
  });

  it('AQI exactly on the line, fresh — multiplier reported, nothing else moves', () => {
    expect(
      assessRisk({ readings: healthySeries(), environment: polluted(150) }).byCategory.respiratory,
    ).toStrictEqual(PRE_CHANGE.healthyAqiBelowLine);
  });

  it('AQI 168 but stale — multiplier reported, nothing else moves', () => {
    expect(
      assessRisk({
        readings: healthySeries(),
        environment: polluted(168, at(-61 * MINUTE)),
        now: at(0),
      }).byCategory.respiratory,
    ).toStrictEqual(PRE_CHANGE.healthyStaleAqi);
  });

  it('no environment at all', () => {
    expect(assessRisk({ readings: healthySeries() }).byCategory.respiratory).toStrictEqual(
      PRE_CHANGE.noEnv,
    );
  });
});

describe('the advisory is never a flag', () => {
  it('is in neither the spec-flag set nor the critical set', () => {
    for (const rule of [
      'respiratory.aqi.unhealthy',
      'respiratory.aqi.veryUnhealthy',
      'respiratory.aqi.hazardous',
    ] as const) {
      expect(SPEC_FLAG_RULES).not.toContain(rule);
      expect(CRITICAL_RULES).not.toContain(rule);
    }
  });

  it('never flags across the whole AQI range with healthy SpO₂', () => {
    for (let aqi = 0; aqi <= 500; aqi += 7) {
      const result = assess(healthySeries(), polluted(aqi));
      expect(result.byCategory.respiratory.flagged).toBe(false);
      expect(result.flaggedRules).toEqual([]);
      expect(result.sosCandidate).toBe(false);
    }
  });
});

describe('thresholds', () => {
  it('lets a caller lower the advisory line (the vulnerable-group hook)', () => {
    const result = assessRisk({
      readings: healthySeries(),
      environment: polluted(120),
      now: at(0),
      thresholds: { env: { aqiAdvisoryAbove: 100 } },
    });
    // Below EPA's Unhealthy band, but above the caller's line: the lowest rung extends
    // downward rather than a new band appearing.
    expect(result.byCategory.respiratory.rule).toBe('respiratory.aqi.unhealthy');
    expect(result.byCategory.respiratory.score).toBe(env.aqiUnhealthyScore);
  });

  it('lets a caller raise the line past a band, in which case that band is skipped', () => {
    const result = assessRisk({
      readings: healthySeries(),
      environment: polluted(180),
      now: at(0),
      thresholds: { env: { aqiAdvisoryAbove: 200 } },
    });
    expect(result.byCategory.respiratory.rule).toBeNull();
  });

  it('repairs a non-monotone score triple so worse air never scores lower', () => {
    const resolved = resolveRiskThresholds({
      env: { aqiUnhealthyScore: 60, aqiVeryUnhealthyScore: 50, aqiHazardousScore: 45 },
    });
    expect(resolved.env.aqiUnhealthyScore).toBe(60);
    expect(resolved.env.aqiVeryUnhealthyScore).toBe(60);
    expect(resolved.env.aqiHazardousScore).toBe(60);
  });

  it('leaves a monotone override inside the cap alone', () => {
    const resolved = resolveRiskThresholds({
      env: { aqiUnhealthyScore: 45, aqiVeryUnhealthyScore: 60, aqiHazardousScore: 70 },
    });
    expect(resolved.env).toMatchObject({
      aqiUnhealthyScore: 45,
      aqiVeryUnhealthyScore: 60,
      aqiHazardousScore: 70,
    });
  });

  it('caps every advisory score at the floor of red, so an SpO₂ flag always outscores it', () => {
    // The guarantee the guidance selection rests on: when an SpO₂ rule fires, its score
    // (≥ 70) is the card's score, and the wording is about blood oxygen. An advisory scoring
    // 95 would put "critically low" under a level the air had set.
    const resolved = resolveRiskThresholds({ env: { aqiHazardousScore: 95 } });
    expect(resolved.env.aqiHazardousScore).toBe(SCORE_BANDS.red.min);

    const flagged = assessRisk({
      readings: spo2Series(91),
      environment: polluted(350),
      now: at(0),
      thresholds: { env: { aqiHazardousScore: 95 } },
    }).byCategory.respiratory;
    expect(flagged.rule).toBe('respiratory.spo2.low');
    expect(flagged.tier).toBe('moderate');
    expect(flagged.guidance).toBe(RESPIRATORY_RECOMMENDATIONS.rungs[0].headline);
    expect(flagged.score).toBeLessThan(90);
  });

  it('floors a negative score at zero', () => {
    expect(resolveRiskThresholds({ env: { aqiUnhealthyScore: -10 } }).env.aqiUnhealthyScore).toBe(0);
  });

  it('returns the defaults untouched when nothing is overridden', () => {
    expect(resolveRiskThresholds().env).toBe(DEFAULT_RISK_THRESHOLDS.env);
    expect(resolveRiskThresholds({}).env).toBe(DEFAULT_RISK_THRESHOLDS.env);
  });
});
