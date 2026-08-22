/**
 * End-to-end tests for the Tier-1 rule engine (PRD §7.2.2).
 *
 * ## How numbers are used here, and why it differs by kind
 *
 * **Spec thresholds are hardcoded as literals**: `92`, `120`, `40`, `103`. They come
 * from PRD §7.2.2, not from tuning, so a `config.ts` edit that drifts from the spec must
 * fail this suite rather than quietly redefining the product. The first block below
 * asserts the config still equals those literals.
 *
 * **Derived thresholds are referenced from `DEFAULT_RISK_THRESHOLDS`** — sustain
 * duration, impact g, stillness duration. Those are expected to be retuned, and a test
 * that hardcoded them would either break on every retune or, worse, keep passing while
 * no longer testing the boundary it claims to.
 *
 * Every "at the boundary" case below is a *pair*: the threshold value itself (which must
 * not fire, since the spec uses strict inequalities) and one step past it (which must).
 */

import { assessRisk } from '../assess';
import { DEFAULT_RISK_THRESHOLDS } from '../config';
import { fahrenheitToCelsius } from '../heat-index';
import type { EnvironmentSnapshot, RiskAssessment, SensorReading } from '../types';

import {
  at,
  healthySeries,
  impactMotion,
  MINUTE,
  reading,
  SECOND,
  series,
  stillMotion,
} from './fixtures';

const { fall, heartRate, spo2: spo2Thresholds, stillness } = DEFAULT_RISK_THRESHOLDS;

/** Heat index well inside NOAA's Normal band — 75 °F. Keeps heat out of the way when
 *  a test is about a different category. */
const COMFORTABLE: EnvironmentSnapshot = { tempC: 24, humidity: 50 };

/** Build an environment whose heat index is exactly `heatIndexF`. Supplying the index
 *  directly (rather than solving for a temp/humidity pair) is what makes the band
 *  boundary assertions exact instead of approximate. */
function envAtHeatIndexF(heatIndexF: number, tempC = 30): EnvironmentSnapshot {
  return { tempC, humidity: 50, heatIndexC: fahrenheitToCelsius(heatIndexF) };
}

function assess(readings: readonly SensorReading[], environment = COMFORTABLE): RiskAssessment {
  return assessRisk({ readings, environment });
}

describe('the spec thresholds have not drifted from PRD §7.2.2', () => {
  it('pins the four specified numbers', () => {
    expect(spo2Thresholds.flagBelow).toBe(92);
    expect(heartRate.tachycardiaAbove).toBe(120);
    expect(heartRate.bradycardiaBelow).toBe(40);
    expect(spo2Thresholds.criticalBelow).toBe(85);
    expect(stillness.heatCriticalMs).toBe(10 * MINUTE);
  });
});

describe('normal, safe readings produce no flags', () => {
  const result = assess(healthySeries());

  it('fires nothing at all', () => {
    expect(result.flaggedRules).toEqual([]);
    expect(result.firedRules).toEqual([]);
    expect(result.criticalRules).toEqual([]);
    expect(result.sosCandidate).toBe(false);
  });

  it('reports green overall and per category', () => {
    expect(result.level).toBe('green');
    for (const category of result.categories) {
      expect(category.level).toBe('green');
      expect(category.flagged).toBe(false);
      expect(category.critical).toBe(false);
      expect(category.score).toBeLessThan(40);
    }
  });

  it('reports full confidence, so green means "fine" and not "unknown"', () => {
    // The distinction this guards is the engine's most dangerous possible lie: a green
    // card rendered from no data at all. Here the data is genuinely there.
    for (const category of result.categories) {
      expect(category.dataQuality).toBe('ok');
    }
  });

  it('keeps the shape the Dashboard already renders', () => {
    expect(result.categories.map((c) => c.key)).toEqual([
      'heat',
      'respiratory',
      'cardiovascular',
      'fall',
    ]);
    expect(result.categories.map((c) => c.label)).toEqual([
      'Heat Stress',
      'Respiratory',
      'Cardiovascular',
      'Fall Detection',
    ]);
    // `metric` is optional on `RiskCategory` but required here, so the card's third
    // line can never render as undefined.
    for (const category of result.categories) {
      expect(typeof category.metric).toBe('string');
      expect(category.metric.length).toBeGreaterThan(0);
      expect(category.guidance.length).toBeGreaterThan(0);
    }
    expect(result.byCategory.respiratory.metric).toBe('SpO₂ 98%');
    expect(result.byCategory.cardiovascular.metric).toBe('HR 72 bpm');
  });

  it('never emits the theme’s fourth colour, which the card cannot label', () => {
    // `RiskCard`'s LEVEL_LABEL is a Record<RiskLevel, string> with no 'neutral' entry,
    // so emitting it would render `undefined` to the user.
    for (const category of result.categories) {
      expect(['green', 'amber', 'red']).toContain(category.level);
    }
  });
});

describe('respiratory flag — SpO₂ < 92% (PRD §7.2.2)', () => {
  const withSpo2 = (value: number) =>
    assess(series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: value }));

  it('does not flag at exactly 92', () => {
    const result = withSpo2(92);
    expect(result.byCategory.respiratory.flagged).toBe(false);
    expect(result.flaggedRules).toEqual([]);
    expect(result.byCategory.respiratory.level).toBe('green');
  });

  it('flags at 91', () => {
    const result = withSpo2(91);
    const respiratory = result.byCategory.respiratory;
    expect(respiratory.flagged).toBe(true);
    expect(respiratory.rule).toBe('respiratory.spo2.low');
    expect(respiratory.level).toBe('red');
    expect(result.flaggedRules).toEqual(['respiratory.spo2.low']);
  });

  it('flags on a single reading, with no sustain requirement', () => {
    // The spec attaches no duration to this one, so one reading is enough — asserted
    // because adding a sustain requirement would be an easy, invisible "improvement".
    const readings = [
      ...series({ count: 5, everyMs: MINUTE, endingAt: at(-MINUTE), spo2: 98, hr: 72 }),
      reading({ at: at(0), spo2: 88, hr: 72, motionSummary: stillMotion() }),
    ];
    expect(assess(readings).byCategory.respiratory.flagged).toBe(true);
  });

  it('does not flag when only an older reading was low', () => {
    // Trailing, not "anywhere in the window": a desaturation that has resolved must
    // clear the card.
    const readings = [
      reading({ at: at(-3 * MINUTE), spo2: 88, hr: 72, motionSummary: stillMotion() }),
      ...series({ count: 3, everyMs: MINUTE, endingAt: at(0), spo2: 98, hr: 72 }),
    ];
    expect(assess(readings).byCategory.respiratory.flagged).toBe(false);
  });

  it('escalates to critical below 85 once confirmed', () => {
    const result = withSpo2(84);
    const respiratory = result.byCategory.respiratory;
    expect(respiratory.flagged).toBe(true);
    expect(respiratory.critical).toBe(true);
    expect(respiratory.criticalRules).toEqual(['respiratory.spo2.critical']);
    expect(result.sosCandidate).toBe(true);
  });

  it('will not escalate on one low reading, so a PPG dropout cannot call for help', () => {
    // The asymmetry is deliberate and safety-critical: the *flag* is instant (as
    // specified), the *emergency* needs corroboration. Optical dropouts routinely emit
    // plausible values in the 70s and 80s that survive every range gate.
    const readings = [
      ...series({ count: 5, everyMs: MINUTE, endingAt: at(-MINUTE), spo2: 98, hr: 72 }),
      reading({ at: at(0), spo2: 84, hr: 72, motionSummary: stillMotion() }),
    ];
    const respiratory = assess(readings).byCategory.respiratory;
    expect(respiratory.flagged).toBe(true);
    expect(respiratory.critical).toBe(false);
    expect(respiratory.criticalRules).toEqual([]);
  });

  it('requires exactly criticalMinSamples corroborating readings', () => {
    const twoLow = [
      ...series({ count: 4, everyMs: MINUTE, endingAt: at(-2 * MINUTE), spo2: 98, hr: 72 }),
      reading({ at: at(-MINUTE), spo2: 84, hr: 72, motionSummary: stillMotion() }),
      reading({ at: at(0), spo2: 84, hr: 72, motionSummary: stillMotion() }),
    ];
    expect(spo2Thresholds.criticalMinSamples).toBe(2);
    expect(assess(twoLow).byCategory.respiratory.critical).toBe(true);
  });
});

describe('cardiovascular flag — HR > 120 sustained at rest (PRD §7.2.2)', () => {
  /** Uniform elevated series. `count - 1` intervals must span `sustainedForMs`. */
  const sustainedAt = (hr: number, count: number) =>
    assess(series({ count, everyMs: MINUTE, endingAt: at(0), hr, spo2: 98 }));

  /** Six readings a minute apart span exactly `sustainedForMs` (5 min) by default. */
  const SUSTAINED_COUNT = heartRate.sustainedForMs / MINUTE + 1;

  it('does not flag at exactly 120, however long it is sustained', () => {
    const result = sustainedAt(120, SUSTAINED_COUNT);
    expect(result.byCategory.cardiovascular.flagged).toBe(false);
    expect(result.byCategory.cardiovascular.firedRules).toEqual([]);
    expect(result.byCategory.cardiovascular.level).toBe('green');
  });

  it('flags at 121 once sustained at rest', () => {
    const result = sustainedAt(121, SUSTAINED_COUNT);
    const cardiovascular = result.byCategory.cardiovascular;
    expect(cardiovascular.flagged).toBe(true);
    expect(cardiovascular.rule).toBe('cardiovascular.hr.tachycardia');
    expect(cardiovascular.level).toBe('red');
    expect(result.flaggedRules).toEqual(['cardiovascular.hr.tachycardia']);
  });

  it('spans exactly sustainedForMs at the boundary, not merely close to it', () => {
    // Guards the half-open-window trap: the lookback is `(now − ms, now]`, so a window
    // exactly `sustainedForMs` wide can only hold a span *strictly less* than it, and
    // the flag would be unsatisfiable — silently, with nothing anywhere reporting it.
    const readings = series({ count: SUSTAINED_COUNT, everyMs: MINUTE, endingAt: at(0), hr: 121 });
    const span = readings[readings.length - 1].timestamp - readings[0].timestamp;
    expect(span).toBe(heartRate.sustainedForMs);
    expect(assess(readings).byCategory.cardiovascular.flagged).toBe(true);
  });

  it('withholds the flag one sample short of sustained, reporting advisory instead', () => {
    const result = sustainedAt(121, SUSTAINED_COUNT - 1);
    const cardiovascular = result.byCategory.cardiovascular;
    expect(cardiovascular.flagged).toBe(false);
    expect(cardiovascular.firedRules).toEqual(['cardiovascular.hr.tachycardia.unconfirmed']);
    // Amber, because a high heart rate really is happening — but not one of the four
    // specified flags, so it must never reach `flaggedRules`.
    expect(cardiovascular.level).toBe('amber');
    expect(result.flaggedRules).toEqual([]);
  });

  it('withholds the flag when the elevation is exertional rather than at rest', () => {
    // "Sustained at rest" is a conjunction. Reporting exercise tachycardia as
    // pathological would train users to dismiss the card, which is its own safety
    // failure.
    const walking = { peakG: 1.9, minG: 0.6, rmsG: 1.05, sampleCount: 50 };
    const result = assess(
      series({
        count: SUSTAINED_COUNT,
        everyMs: MINUTE,
        endingAt: at(0),
        hr: 130,
        motionSummary: walking,
      }),
    );
    const cardiovascular = result.byCategory.cardiovascular;
    expect(cardiovascular.flagged).toBe(false);
    expect(cardiovascular.firedRules).toEqual(['cardiovascular.hr.tachycardia.unconfirmed']);
  });

  it('tolerates brief movement inside an otherwise resting run', () => {
    // Reaching for a glass twice in five minutes must not disqualify genuine resting
    // tachycardia — that is what `minRestFraction` buys.
    const readings = series({
      count: SUSTAINED_COUNT,
      everyMs: MINUTE,
      endingAt: at(0),
      hr: 130,
    }).map((r, index) =>
      index === 1 || index === 3
        ? { ...r, motionSummary: { peakG: 1.9, minG: 0.6, rmsG: 1.05, sampleCount: 50 } }
        : r,
    );
    expect(assess(readings).byCategory.cardiovascular.flagged).toBe(true);
  });

  it('still flags when the device reports no motion at all', () => {
    // Fail-sensitive on purpose. A BLE chest strap with no accelerometer channel would
    // otherwise be unable to ever produce this flag, and nothing would say so.
    const readings = series({
      count: SUSTAINED_COUNT,
      everyMs: MINUTE,
      endingAt: at(0),
      hr: 121,
    }).map(({ motionSummary: _dropped, ...rest }) => rest);
    const cardiovascular = assess(readings).byCategory.cardiovascular;
    expect(cardiovascular.flagged).toBe(true);
    // ...but says the level rests on thinner evidence.
    expect(cardiovascular.dataQuality).toBe('partial');
  });

  it('is not an emergency trigger on its own', () => {
    // PRD §7.2.5 does not list tachycardia. Neither heart-rate predicate may set
    // `sosCandidate` by itself.
    const result = sustainedAt(121, SUSTAINED_COUNT);
    expect(result.criticalRules).toEqual([]);
    expect(result.sosCandidate).toBe(false);
  });
});

describe('cardiovascular flag — HR < 40 (PRD §7.2.2)', () => {
  const withHr = (hr: number) =>
    assess(series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr, spo2: 98 }));

  it('does not flag at exactly 40', () => {
    const result = withHr(40);
    expect(result.byCategory.cardiovascular.flagged).toBe(false);
    expect(result.byCategory.cardiovascular.level).toBe('green');
  });

  it('flags at 39', () => {
    const result = withHr(39);
    const cardiovascular = result.byCategory.cardiovascular;
    expect(cardiovascular.flagged).toBe(true);
    expect(cardiovascular.rule).toBe('cardiovascular.hr.bradycardia');
    expect(cardiovascular.level).toBe('red');
  });

  it('flags on a single reading, with no sustain or rest condition', () => {
    // The spec qualifies tachycardia with "sustained at rest" and attaches nothing to
    // bradycardia. That asymmetry is intentional and is asserted rather than assumed:
    // there is no benign everyday activity that drives heart rate *down* through 40,
    // and sustain-gating it would miss the transient severe episodes that matter most.
    const readings = [
      ...series({ count: 5, everyMs: MINUTE, endingAt: at(-MINUTE), hr: 72, spo2: 98 }),
      reading({ at: at(0), hr: 38, spo2: 98, motionSummary: stillMotion() }),
    ];
    expect(assess(readings).byCategory.cardiovascular.flagged).toBe(true);
  });

  it('rejects an implausible zero rather than reading it as arrest', () => {
    // An adapter that fills a missing signal with 0 must not be able to fire this.
    const readings = [
      ...series({ count: 5, everyMs: MINUTE, endingAt: at(-MINUTE), hr: 72, spo2: 98 }),
      reading({ at: at(0), hr: 0, spo2: 98, motionSummary: stillMotion() }),
    ];
    const cardiovascular = assess(readings).byCategory.cardiovascular;
    expect(cardiovascular.flagged).toBe(false);
    expect(cardiovascular.dataQuality).toBe('partial');
  });
});

describe('heat-stress flag — Danger or Extreme Danger band (PRD §7.2.2)', () => {
  const withHeatIndexF = (heatIndexF: number) => assess(healthySeries(), envAtHeatIndexF(heatIndexF));

  it('does not flag just below the Danger floor of 103°F', () => {
    const result = withHeatIndexF(102.9);
    expect(result.byCategory.heat.flagged).toBe(false);
    expect(result.heatIndexBand?.label).toBe('Extreme Caution');
    // Amber: NOAA's own Extreme Caution band, a documented precursor rather than an
    // invented intermediate level.
    expect(result.byCategory.heat.level).toBe('amber');
    expect(result.byCategory.heat.firedRules).toEqual(['heat.index.extremeCaution']);
    expect(result.flaggedRules).toEqual([]);
  });

  it('flags at exactly 103°F, inclusively', () => {
    const result = withHeatIndexF(103);
    expect(result.byCategory.heat.flagged).toBe(true);
    expect(result.heatIndexBand?.label).toBe('Danger');
    expect(result.byCategory.heat.level).toBe('red');
    expect(result.flaggedRules).toEqual(['heat.index.danger']);
  });

  it('reports Extreme Danger separately at 125°F', () => {
    expect(withHeatIndexF(124.9).byCategory.heat.rule).toBe('heat.index.danger');
    const extreme = withHeatIndexF(125);
    expect(extreme.byCategory.heat.rule).toBe('heat.index.extremeDanger');
    expect(extreme.byCategory.heat.flagged).toBe(true);
    expect(extreme.flaggedRules).toEqual(['heat.index.extremeDanger']);
  });

  it('derives the flag from temperature and humidity, as specified', () => {
    // The end-to-end path PRD §7.2.2 actually describes ("from temp + humidity").
    // 34 °C / 50 % is 101.1 °F (Extreme Caution); 35 °C / 50 % is 105.2 °F (Danger).
    const below = assess(healthySeries(), { tempC: 34, humidity: 50 });
    const above = assess(healthySeries(), { tempC: 35, humidity: 50 });
    expect(below.byCategory.heat.flagged).toBe(false);
    expect(above.byCategory.heat.flagged).toBe(true);
    expect(above.heatIndexC).toBeCloseTo(40.68, 1);
  });

  it('re-bands a provider-supplied index instead of trusting its label', () => {
    // A weather API's "feels like" is not necessarily a NOAA heat index, and the flag
    // must key off NOAA's bands to mean what the spec says it means.
    const result = assess(healthySeries(), {
      tempC: 30,
      humidity: 50,
      heatIndexC: fahrenheitToCelsius(110),
    });
    expect(result.byCategory.heat.flagged).toBe(true);
    expect(result.heatIndexBand?.label).toBe('Danger');
  });

  it('cannot assess heat with no weather data, and says so', () => {
    const result = assessRisk({ readings: healthySeries() });
    expect(result.heatIndexC).toBeNull();
    expect(result.heatIndexBand).toBeNull();
    expect(result.byCategory.heat.flagged).toBe(false);
    expect(result.byCategory.heat.dataQuality).toBe('missing');
    expect(result.byCategory.heat.metric).toBe('Heat index —');
  });
});

describe('heat collapse escalation — extreme heat plus no motion (PRD §7.2.5)', () => {
  const extremeHeat = envAtHeatIndexF(130);

  /** Still readings one minute apart, `count` of them, ending at T0. */
  const stillFor = (count: number) =>
    series({ count, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 98 });

  it('does not escalate at exactly 10 minutes of stillness', () => {
    // The spec says "> 10 min", so the boundary itself must not fire.
    const readings = stillFor(stillness.heatCriticalMs / MINUTE + 1);
    const span = readings[readings.length - 1].timestamp - readings[0].timestamp;
    expect(span).toBe(stillness.heatCriticalMs);

    const result = assess(readings, extremeHeat);
    expect(result.byCategory.heat.flagged).toBe(true);
    expect(result.byCategory.heat.critical).toBe(false);
    expect(result.sosCandidate).toBe(false);
  });

  it('escalates past 10 minutes of stillness', () => {
    // This case also guards the second half-open-window trap: the stillness lookback
    // must exceed `heatCriticalMs`, or the oldest reading falls outside it and `>` can
    // never be satisfied. With a lookback of exactly 10 minutes this test fails.
    const result = assess(stillFor(stillness.heatCriticalMs / MINUTE + 2), extremeHeat);
    expect(result.byCategory.heat.critical).toBe(true);
    expect(result.criticalRules).toEqual(['heat.stillness.critical']);
    expect(result.sosCandidate).toBe(true);
    expect(result.byCategory.heat.rule).toBe('heat.stillness.critical');
  });

  it('does not escalate on long stillness alone, without extreme heat', () => {
    const result = assess(stillFor(stillness.heatCriticalMs / MINUTE + 2), COMFORTABLE);
    expect(result.criticalRules).toEqual([]);
    expect(result.sosCandidate).toBe(false);
  });

  it('does not escalate on extreme heat alone, while the person is moving', () => {
    const active = { peakG: 1.9, minG: 0.6, rmsG: 1.05, sampleCount: 50 };
    const readings = series({
      count: stillness.heatCriticalMs / MINUTE + 2,
      everyMs: MINUTE,
      endingAt: at(0),
      hr: 72,
      spo2: 98,
      motionSummary: active,
    });
    const result = assess(readings, extremeHeat);
    expect(result.byCategory.heat.flagged).toBe(true);
    expect(result.criticalRules).toEqual([]);
  });

  it('does not count a sensor outage as stillness', () => {
    // Two still readings ten minutes apart with nothing between them are ten minutes of
    // *unobserved* time, not confirmed stillness. Counting it would manufacture an
    // emergency out of a dropout.
    const readings = [
      reading({ at: at(-12 * MINUTE), hr: 72, spo2: 98, motionSummary: stillMotion() }),
      reading({ at: at(0), hr: 72, spo2: 98, motionSummary: stillMotion() }),
    ];
    const result = assess(readings, extremeHeat);
    expect(result.byCategory.heat.critical).toBe(false);
  });
});

describe('fall flag — spike then subsequent stillness (PRD §7.2.2)', () => {
  /** An impact at T0 followed by `stillCount` still readings one second apart. */
  function fallScenario(peakG: number, stillCount: number): SensorReading[] {
    const readings: SensorReading[] = [
      reading({ at: at(0), hr: 72, spo2: 98, motionSummary: impactMotion(peakG) }),
    ];
    for (let index = 1; index <= stillCount; index += 1) {
      readings.push(
        reading({ at: at(index * SECOND), hr: 72, spo2: 98, motionSummary: stillMotion() }),
      );
    }
    return readings;
  }

  /** Still readings needed for the run to span `stillnessMs` exactly. */
  const STILL_COUNT = fall.stillnessMs / SECOND + 1;

  it('flags an impact followed by stillness for exactly stillnessMs', () => {
    const readings = fallScenario(3, STILL_COUNT);
    const stillSpan =
      readings[readings.length - 1].timestamp - readings[1].timestamp;
    expect(stillSpan).toBe(fall.stillnessMs);

    const result = assess(readings);
    const fallCategory = result.byCategory.fall;
    expect(fallCategory.flagged).toBe(true);
    expect(fallCategory.rule).toBe('fall.impactThenStillness');
    expect(fallCategory.level).toBe('red');
    expect(result.flaggedRules).toEqual(['fall.impactThenStillness']);
  });

  it('withholds the flag one second short of stillnessMs', () => {
    const result = assess(fallScenario(3, STILL_COUNT - 1));
    const fallCategory = result.byCategory.fall;
    expect(fallCategory.flagged).toBe(false);
    expect(fallCategory.firedRules).toEqual(['fall.impact.unconfirmed']);
    expect(fallCategory.level).toBe('amber');
    expect(result.flaggedRules).toEqual([]);
  });

  it('treats a peak of exactly impactG as an impact', () => {
    // Inclusive, so the configured number is the first value that fires rather than the
    // last that does not.
    expect(assess(fallScenario(fall.impactG, STILL_COUNT)).byCategory.fall.flagged).toBe(true);
  });

  it('does not treat a peak just below impactG as an impact', () => {
    const result = assess(fallScenario(fall.impactG - 0.01, STILL_COUNT));
    expect(result.byCategory.fall.flagged).toBe(false);
    expect(result.byCategory.fall.firedRules).toEqual([]);
  });

  it('does not flag stillness with no preceding impact', () => {
    // Someone sitting quietly. Both halves of the sequence are required.
    const result = assess(healthySeries());
    expect(result.byCategory.fall.flagged).toBe(false);
    expect(result.byCategory.fall.firedRules).toEqual([]);
  });

  it('does not flag an impact the user walks away from', () => {
    const active = { peakG: 1.9, minG: 0.6, rmsG: 1.05, sampleCount: 50 };
    const readings: SensorReading[] = [
      reading({ at: at(0), hr: 72, spo2: 98, motionSummary: impactMotion(3) }),
      ...Array.from({ length: 20 }, (_unused, index) =>
        reading({ at: at((index + 1) * SECOND), hr: 72, spo2: 98, motionSummary: active }),
      ),
    ];
    const result = assess(readings);
    expect(result.byCategory.fall.flagged).toBe(false);
    expect(result.byCategory.fall.rule).toBe('fall.impact.unconfirmed');
  });

  it('distinguishes "too early to say" from "not a fall"', () => {
    // One second after an impact, `stillnessMs` of stillness is not yet observable.
    // Answering "no fall" here is how a real fall gets a green card.
    const result = assess(fallScenario(3, 1));
    const fallCategory = result.byCategory.fall;
    expect(fallCategory.flagged).toBe(false);
    expect(fallCategory.dataQuality).toBe('partial');
    expect(fallCategory.guidance).toContain('checking');
  });

  it('escalates while the stillness is ongoing', () => {
    const result = assess(fallScenario(3, STILL_COUNT));
    expect(result.byCategory.fall.critical).toBe(true);
    expect(result.criticalRules).toEqual(['fall.impactThenStillness']);
    expect(result.sosCandidate).toBe(true);
  });

  it('keeps the flag but drops the escalation once the person gets up', () => {
    // The fall did happen, so it still flags. But someone who fell and then walked away
    // does not need their emergency contacts called.
    const active = { peakG: 1.9, minG: 0.6, rmsG: 1.05, sampleCount: 50 };
    const readings: SensorReading[] = [
      ...fallScenario(3, STILL_COUNT),
      reading({ at: at(20 * SECOND), hr: 72, spo2: 98, motionSummary: active }),
    ];
    const fallCategory = assess(readings).byCategory.fall;
    expect(fallCategory.flagged).toBe(true);
    expect(fallCategory.critical).toBe(false);
  });

  it('does not let a free-fall-plus-impact interval average out to "still"', () => {
    // `impactMotion` reproduces the real artifact: rms ≈ 1 g because free-fall (≈0 g)
    // and impact (≫1 g) average back to rest. A mean-only stillness test would classify
    // the very interval containing the fall as still, and the impact would then confirm
    // *itself*.
    const readings = [reading({ at: at(0), hr: 72, spo2: 98, motionSummary: impactMotion(3) })];
    const fallCategory = assess(readings).byCategory.fall;
    expect(fallCategory.flagged).toBe(false);
    expect(fallCategory.rule).toBe('fall.impact.unconfirmed');
  });

  it('reports honestly when movement is not monitored at all', () => {
    const readings = series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 98 }).map(
      ({ motionSummary: _dropped, ...rest }) => rest,
    );
    const fallCategory = assess(readings).byCategory.fall;
    expect(fallCategory.flagged).toBe(false);
    expect(fallCategory.dataQuality).toBe('missing');
    expect(fallCategory.metric).toBe('No motion data');
  });
});

describe('combined and critical cases', () => {
  it('fires all four specified flags at once and reports both escalations', () => {
    // Someone collapsed in extreme heat: an impact five minutes ago, still since, with
    // sustained tachycardia and critically low oxygen throughout.
    const readings: SensorReading[] = [
      reading({
        at: at(-5 * MINUTE),
        hr: 121,
        spo2: 84,
        motionSummary: impactMotion(3),
      }),
      reading({ at: at(-5 * MINUTE + 10 * SECOND), hr: 121, spo2: 84, motionSummary: stillMotion() }),
      reading({ at: at(-5 * MINUTE + 20 * SECOND), hr: 121, spo2: 84, motionSummary: stillMotion() }),
      reading({ at: at(-5 * MINUTE + 30 * SECOND), hr: 121, spo2: 84, motionSummary: stillMotion() }),
      ...series({ count: 5, everyMs: MINUTE, endingAt: at(0), hr: 121, spo2: 84 }),
    ];

    const result = assess(readings, envAtHeatIndexF(130));

    // Order follows the Dashboard's category order, which is deterministic.
    expect(result.flaggedRules).toEqual([
      'heat.index.extremeDanger',
      'respiratory.spo2.low',
      'cardiovascular.hr.tachycardia',
      'fall.impactThenStillness',
    ]);
    expect(result.criticalRules).toEqual([
      'respiratory.spo2.critical',
      'fall.impactThenStillness',
    ]);
    expect(result.sosCandidate).toBe(true);
    expect(result.level).toBe('red');
    for (const category of result.categories) {
      expect(category.flagged).toBe(true);
    }
  });

  it('takes the top-level level from the worst category', () => {
    const readings = series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 91 });
    const result = assess(readings);
    expect(result.byCategory.respiratory.level).toBe('red');
    expect(result.byCategory.cardiovascular.level).toBe('green');
    expect(result.level).toBe('red');
  });

  it('reports amber overall when only a precursor fired', () => {
    const result = assess(healthySeries(), envAtHeatIndexF(95));
    expect(result.level).toBe('amber');
    expect(result.flaggedRules).toEqual([]);
    // Amber with no specified flag is exactly the state that must not be mistaken for
    // one of the four, which is what `flagged` is for.
    expect(result.byCategory.heat.flagged).toBe(false);
  });

  it('keeps categories independent — one flag does not colour the others', () => {
    const readings = series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 88 });
    const result = assess(readings);
    expect(result.byCategory.respiratory.flagged).toBe(true);
    expect(result.byCategory.cardiovascular.flagged).toBe(false);
    expect(result.byCategory.fall.flagged).toBe(false);
    expect(result.byCategory.heat.flagged).toBe(false);
  });

  it('reports the environmental multiplier without folding it into the score', () => {
    // Fusion applies it; the engine only reports it. Applying it in both places would
    // square the effect.
    const clean = assess(healthySeries(), { tempC: 24, humidity: 50, aqi: 40 });
    const polluted = assess(healthySeries(), { tempC: 24, humidity: 50, aqi: 300 });
    expect(clean.byCategory.respiratory.envMultiplier).toBe(1);
    expect(polluted.byCategory.respiratory.envMultiplier).toBeCloseTo(1.3, 5);
    expect(polluted.byCategory.respiratory.score).toBe(clean.byCategory.respiratory.score);
    // Air quality alone must never manufacture a respiratory flag.
    expect(polluted.byCategory.respiratory.flagged).toBe(false);
  });

  it('amplifies cardiovascular strain while the heat flag is firing', () => {
    const hot = assess(healthySeries(), envAtHeatIndexF(110));
    expect(hot.byCategory.cardiovascular.envMultiplier).toBeCloseTo(1.2, 5);
    expect(assess(healthySeries()).byCategory.cardiovascular.envMultiplier).toBe(1);
  });
});

describe('the engine is a pure function of its input', () => {
  it('returns identical results for identical input', () => {
    const readings = healthySeries();
    expect(assess(readings)).toEqual(assess(readings));
  });

  it('never mutates the caller’s buffer', () => {
    // The ingestion layer owns a live ring buffer; sorting it in place would corrupt it.
    const readings = healthySeries();
    const before = JSON.stringify(readings);
    assess(readings);
    expect(JSON.stringify(readings)).toBe(before);
  });

  it('tolerates unsorted input', () => {
    const sorted = healthySeries();
    const shuffled = [sorted[3], sorted[0], sorted[5], sorted[1], sorted[4], sorted[2]];
    expect(assess(shuffled)).toEqual(assess(sorted));
  });

  it('anchors to the newest reading rather than a clock', () => {
    // No `now` is supplied anywhere in this suite, yet every duration rule works. If a
    // clock were read internally, these fixtures — stamped in 2023 — would all be stale.
    const result = assess(healthySeries());
    expect(result.evaluatedAt).toBe(at(0));
    expect(result.byCategory.respiratory.dataQuality).toBe('ok');
  });

  it('honours an explicit evaluation instant', () => {
    const stale = assessRisk({
      readings: healthySeries(),
      environment: COMFORTABLE,
      now: at(30 * MINUTE),
    });
    expect(stale.evaluatedAt).toBe(at(30 * MINUTE));
    // Every reading now falls outside the window entirely.
    expect(stale.sampleCount).toBe(0);
    expect(stale.byCategory.respiratory.dataQuality).toBe('missing');
  });

  it('drops future-dated readings', () => {
    // BLE clock skew is routine, and a reading stamped an hour ahead would otherwise
    // sit in every window forever, pinning a stale flag on indefinitely.
    const readings = [
      ...healthySeries(),
      reading({ at: at(60 * MINUTE), hr: 200, spo2: 60, motionSummary: stillMotion() }),
    ];
    const result = assessRisk({ readings, environment: COMFORTABLE, now: at(0) });
    expect(result.flaggedRules).toEqual([]);
    expect(result.sampleCount).toBe(6);
  });
});

describe('empty and degraded input never claims the user is fine', () => {
  it('reports missing data rather than green health for an empty buffer', () => {
    const result = assessRisk({ readings: [] });
    expect(result.level).toBe('green');
    expect(result.flaggedRules).toEqual([]);
    expect(result.sosCandidate).toBe(false);
    // Green is the only level available, so `dataQuality` carries the whole truth.
    for (const category of result.categories) {
      expect(category.dataQuality).toBe('missing');
    }
    expect(result.sampleCount).toBe(0);
  });

  it('marks vitals stale when the newest reading is too old', () => {
    const result = assessRisk({
      readings: healthySeries(at(-5 * MINUTE)),
      environment: COMFORTABLE,
      now: at(0),
    });
    expect(result.byCategory.respiratory.dataQuality).toBe('stale');
    expect(result.byCategory.cardiovascular.dataQuality).toBe('stale');
  });

  it('does not mark weather stale on the vitals clock', () => {
    // Weather observations are legitimately tens of minutes old; sharing one staleness
    // bound would flag every heat assessment as stale.
    const result = assessRisk({
      readings: healthySeries(),
      environment: { ...COMFORTABLE, observedAt: at(-20 * MINUTE) },
      now: at(0),
    });
    expect(result.byCategory.heat.dataQuality).toBe('ok');
  });

  it('reports partial confidence below the minimum sample count', () => {
    const result = assess(series({ count: 2, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 98 }));
    expect(result.byCategory.respiratory.dataQuality).toBe('partial');
  });

  it('repairs a config that would make the tachycardia flag unsatisfiable', () => {
    // A window no wider than the sustain duration is mathematically unsatisfiable
    // because the lookback is half-open. `assessRisk` runs every tick, so this is
    // repaired rather than thrown — throwing would take the app down mid-monitoring.
    const result = assessRisk({
      readings: series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 121, spo2: 98 }),
      environment: COMFORTABLE,
      thresholds: { window: { ms: heartRate.sustainedForMs } },
    });
    expect(result.windowMs).toBeGreaterThan(heartRate.sustainedForMs);
    expect(result.byCategory.cardiovascular.flagged).toBe(true);
  });
});

/**
 * Structural invariants, swept over a grid rather than argued per rule.
 *
 * These exist because of a shipped defect no per-rule test caught: the cardiovascular
 * rule could return `flagged: true` with `level: 'green'`, because the flag was decided
 * from a sustained run while the score was computed from the newest reading alone. The
 * card rendered green with a green dot while the engine internally considered the episode
 * a flag — the single most dangerous output available to it.
 *
 * That was not really a tachycardia bug; it was a *consistency* bug, and three other
 * rules compute a flag and a score by separate routes and could acquire the same one. So
 * the relationships are asserted for every rule at once, across a cross product of vitals,
 * motion shapes, and environments. Failures report the offending scenario labels rather
 * than a bare `false`, so a violation names itself.
 */
describe('no rule can report a flag and a level that disagree', () => {
  type Scenario = { readonly label: string; readonly result: RiskAssessment };

  const HR_VALUES = [20, 39, 40, 41, 72, 100, 119, 120, 121, 150, 300];
  const SPO2_VALUES = [50, 84, 85, 91, 92, 98, 100];
  const ENVIRONMENTS: readonly (readonly [string, EnvironmentSnapshot])[] = [
    ['comfortable', COMFORTABLE],
    ['danger', envAtHeatIndexF(103)],
    ['extreme', envAtHeatIndexF(130)],
  ];

  /** Impact then five still readings — the one shape that confirms a fall. */
  function fallLike(hr: number, spo2: number): SensorReading[] {
    const readings = [reading({ at: at(-60 * SECOND), hr, spo2, motionSummary: impactMotion(3) })];
    for (let offset = 50; offset >= 0; offset -= 10) {
      readings.push(
        reading({ at: at(-offset * SECOND), hr, spo2, motionSummary: stillMotion() }),
      );
    }
    return readings;
  }

  const SHAPES: readonly (readonly [string, (hr: number, spo2: number) => SensorReading[]])[] = [
    [
      'still',
      (hr, spo2) => series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr, spo2 }),
    ],
    [
      // Deliberately included: with a uniform series the newest reading is always the
      // run's peak, so a rule that scores off the newest sample looks correct. That is
      // precisely how the flagged-but-green defect survived. An 8 bpm dip on the last
      // reading is one standard error for consumer optical HR.
      'noise-dip-on-newest',
      (hr, spo2) =>
        series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr, spo2 }).map((r, index) =>
          index === 5 ? { ...r, hr: Math.max(hr - 8, 20) } : r,
        ),
    ],
    [
      'no-motion-channel',
      (hr, spo2) =>
        series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr, spo2 }).map(
          ({ motionSummary: _dropped, ...rest }) => rest,
        ),
    ],
    ['impact-then-still', fallLike],
  ];

  const SCENARIOS: Scenario[] = [];
  for (const hr of HR_VALUES) {
    for (const spo2 of SPO2_VALUES) {
      for (const [shapeLabel, build] of SHAPES) {
        for (const [envLabel, environment] of ENVIRONMENTS) {
          SCENARIOS.push({
            label: `hr=${hr} spo2=${spo2} ${shapeLabel} ${envLabel}`,
            result: assessRisk({ readings: build(hr, spo2), environment }),
          });
        }
      }
    }
  }

  /** Names of scenarios in which any category violates `holds`. */
  function violations(holds: (category: RiskAssessment['categories'][number]) => boolean): string[] {
    return SCENARIOS.filter(({ result }) => !result.categories.every(holds)).map(
      ({ label }) => label,
    );
  }

  it('sweeps a grid wide enough to reach every flag', () => {
    // A sweep that never fires anything would pass every invariant below vacuously.
    const fired = new Set(SCENARIOS.flatMap(({ result }) => result.flaggedRules));
    expect([...fired].sort()).toEqual([
      'cardiovascular.hr.bradycardia',
      'cardiovascular.hr.tachycardia',
      'fall.impactThenStillness',
      'heat.index.danger',
      'heat.index.extremeDanger',
      'respiratory.spo2.low',
    ]);
    expect(SCENARIOS.length).toBe(
      HR_VALUES.length * SPO2_VALUES.length * SHAPES.length * ENVIRONMENTS.length,
    );
  });

  it('never pairs a flag with a green level', () => {
    // The defect this block exists for.
    expect(violations((category) => !category.flagged || category.level !== 'green')).toEqual([]);
  });

  it('never pairs a flag with a null rule id', () => {
    expect(violations((category) => !category.flagged || category.rule !== null)).toEqual([]);
  });

  it('reports the most severe fired rule as `rule`', () => {
    expect(violations((category) => category.rule === (category.firedRules[0] ?? null))).toEqual([]);
  });

  it('only marks a fired rule critical', () => {
    expect(
      violations((category) =>
        category.criticalRules.every((rule) => category.firedRules.includes(rule)),
      ),
    ).toEqual([]);
  });

  it('never reports a critical rule below red', () => {
    expect(
      violations((category) => category.criticalRules.length === 0 || category.level === 'red'),
    ).toEqual([]);
  });

  it('keeps every score inside 0–100 and every level inside the three bands', () => {
    expect(
      violations(
        (category) =>
          category.score >= 0 &&
          category.score <= 100 &&
          ['green', 'amber', 'red'].includes(category.level),
      ),
    ).toEqual([]);
  });

  it('escalates to SOS only on a critical rule', () => {
    const offenders = SCENARIOS.filter(
      ({ result }) => result.sosCandidate && result.criticalRules.length === 0,
    ).map(({ label }) => label);
    expect(offenders).toEqual([]);
  });

  it('promotes only category-fired rules to the top-level flag list', () => {
    const offenders = SCENARIOS.filter(({ result }) => {
      const fired = new Set(result.categories.flatMap((category) => category.firedRules));
      return !result.flaggedRules.every((rule) => fired.has(rule));
    }).map(({ label }) => label);
    expect(offenders).toEqual([]);
  });
});

