/**
 * Personal baseline tracking (PRD §7.2.1 extension) — the comparison, its units, its
 * boundaries, and its reachability at the polling cadence PRD §7.2.1 actually specifies.
 *
 * ## Why a display feature gets the cadence grid too
 * `src/risk/baseline.ts` needs four in-window readings before it will state an average, and a
 * sample-count floor is the exact shape of the bug this engine has now been dug out of five
 * times: a threshold the poll interval cannot satisfy, failing silently. It is *worse* here
 * than in the rule layer. A rule that never fires leaves a green card, which at least looks
 * like a claim; a comparison that never resolves leaves the row reading "not enough readings
 * yet" forever, which looks like a device still warming up. Nobody files that as a bug. So the
 * grid runs 1 s through 60 s, and the 60 s case is run again with a full interval of freshness
 * lag, which is the worst alignment a real poll produces.
 *
 * ## Why the units are asserted and not just documented
 * The three vitals are reported in three different units on purpose — percent for heart rate,
 * percentage *points* for SpO₂, degrees for skin temperature — and the reasoning is a paragraph
 * in the module header that cannot fail. "SpO₂ is 3% below your average" is the specific wrong
 * answer that reasoning exists to prevent, and it is one careless refactor away, so
 * `percentDelta` is asserted null for the two interval-scale vitals and non-null for the one
 * ratio-scale vital.
 *
 * ## Why the row must not be able to agree with the cards
 * The tempting invariant is "if the dehydration rule reports a rise, the row does too". It is
 * false, and `mock-sensor-window.test.ts` pins the counterexample: they read 10 and 15 minutes
 * respectively, so a rise that fills nine minutes is mostly baked into the 10-minute average
 * and barely visible against it. Both numbers are correct. What is asserted here instead is the
 * narrower, true property — that the *deadband* is never the reason for the silence.
 *
 * ## Why the containment is asserted
 * This module produces no level, no score, and no rule id, and the last section of the file
 * proves a 15 % deviation moves nothing in `RiskAssessment`. A "deviation" quietly becoming a
 * seventh risk signal is how a description turns into an unspecified, undocumented rule.
 */

import { assessRisk } from '../assess';
import { computeVitalBaselines, formatWindowLabel, type VitalBaselines } from '../baseline';
import { DEFAULT_RISK_THRESHOLDS, resolveRiskThresholds } from '../config';
import type { EnvironmentSnapshot, PartialRiskThresholds, SensorReading } from '../types';
import { at, MINUTE, reading, SECOND, stillMotion } from './fixtures';

const { baseline, dehydration, plausible, window } = DEFAULT_RISK_THRESHOLDS;

/** Nothing here reads the weather; a comfortable snapshot keeps the cards quiet so the
 *  containment assertions at the bottom mean what they say. */
const COMFORTABLE: EnvironmentSnapshot = { tempC: 24, humidity: 50 };

/** Positions in `VitalBaselines.vitals`, whose order is asserted in the first test below. */
const HR = 0;
const SPO2 = 1;
const SKIN = 2;

type WindowSpec = {
  readonly cadenceMs: number;
  /** Value carried by every reading *except* the newest — so the mean is exactly this. */
  readonly hr?: number;
  readonly spo2?: number;
  readonly skinTempC?: number;
  /** The newest reading's values. Each defaults to its history value, i.e. a flat window. */
  readonly currentHr?: number;
  readonly currentSpo2?: number;
  readonly currentSkinTempC?: number;
  /** Span covered. Defaults to the engine's own window, so the buffer is what it reads. */
  readonly spanMs?: number;
  /** Age of the newest reading — the freshness lag a real poll always has. */
  readonly lagMs?: number;
};

/**
 * A window at `cadenceMs`, built backwards from `now`.
 *
 * Every reading but the newest carries the same value, which makes the expected average exactly
 * that value at every cadence. That is the point of the construction: a fixture whose mean
 * shifted with the sample count could not distinguish "computed the average correctly" from
 * "computed a different average correctly".
 */
function windowOf(spec: WindowSpec): SensorReading[] {
  const spanMs = spec.spanMs ?? window.ms;
  const lagMs = spec.lagMs ?? 0;
  const hr = spec.hr ?? 80;
  const spo2 = spec.spo2 ?? 98;
  const skinTempC = spec.skinTempC ?? 34;
  const readings: SensorReading[] = [];

  for (let offset = lagMs; offset < spanMs; offset += spec.cadenceMs) {
    const current = offset === lagMs;
    readings.push(
      reading({
        at: at(-offset),
        hr: current ? (spec.currentHr ?? hr) : hr,
        spo2: current ? (spec.currentSpo2 ?? spo2) : spo2,
        skinTempC: current ? (spec.currentSkinTempC ?? skinTempC) : skinTempC,
        motionSummary: stillMotion(),
      }),
    );
  }

  return readings.reverse();
}

/**
 * The pairing the module is designed around: one `assessRisk` call, and the baselines derived
 * from *that* assessment. Nothing in these tests can hand the two different windows, which is
 * the property the signature exists to enforce.
 */
function baselinesFor(
  readings: readonly SensorReading[],
  thresholds?: PartialRiskThresholds,
): VitalBaselines {
  const assessment = assessRisk({ readings, environment: COMFORTABLE, now: at(0), thresholds });
  return computeVitalBaselines({ readings, assessment, thresholds });
}

describe('the comparison resolves at every polling cadence PRD §7.2.1 allows', () => {
  const CADENCES = [1 * SECOND, 5 * SECOND, 10 * SECOND, 30 * SECOND, 60 * SECOND];

  it('reports the three vitals in the order the Dashboard renders them', () => {
    expect(baselinesFor(windowOf({ cadenceMs: 60 * SECOND })).vitals.map((v) => v.field)).toEqual([
      'hr',
      'spo2',
      'skinTempC',
    ]);
  });

  it.each(CADENCES)('states a 15%% rise against the window average at %ims', (cadenceMs) => {
    // 80 bpm throughout, 92 on the newest reading. The average is exactly 80 at every cadence,
    // so 15 % is exact rather than approximately-15 — and the sentence is the one the brief
    // asked for, word for word.
    const vital = baselinesFor(windowOf({ cadenceMs, hr: 80, currentHr: 92 })).vitals[HR];

    expect(vital.baseline).toBe(80);
    expect(vital.delta).toBe(12);
    expect(vital.percentDelta).toBe(15);
    expect(vital.direction).toBe('above');
    expect(vital.short).toBe('+15%');
    expect(vital.summary).toBe('Heart rate is 15% above your 10-minute average.');
    expect(vital.dataQuality).toBe('ok');
  });

  it.each(CADENCES)('stays quiet on a window that has not moved, at %ims', (cadenceMs) => {
    // The negative half of the grid. Without it, a row that reported a deviation
    // unconditionally would pass every assertion above.
    const vital = baselinesFor(windowOf({ cadenceMs, hr: 80 })).vitals[HR];

    expect(vital.delta).toBe(0);
    expect(vital.meaningful).toBe(false);
    expect(vital.direction).toBe('level');
    expect(vital.short).toBe('In line');
    expect(vital.summary).toBe('Heart rate is in line with your 10-minute average.');
  });

  it('resolves at the slowest cadence with a full interval of freshness lag', () => {
    // The worst alignment a real poll produces, and the one that has broken this engine
    // before: a 60 s poll whose newest reading is already 60 s old loses a sample off each end
    // of a half-open window. The surviving count is pinned rather than just "reports", so a
    // regression that leaves it barely satisfied shows as a changed number.
    const vital = baselinesFor(
      windowOf({ cadenceMs: 60 * SECOND, lagMs: 60 * SECOND, hr: 80, currentHr: 92 }),
    ).vitals[HR];

    expect(vital.sampleCount).toBe(9);
    expect(vital.baselineCount).toBe(8);
    expect(vital.short).toBe('+15%');
    expect(vital.dataQuality).toBe('ok');
  });

  it('averages every in-window sample except the newest', () => {
    const vital = baselinesFor(windowOf({ cadenceMs: 60 * SECOND, hr: 80, currentHr: 92 }))
      .vitals[HR];

    // Ten readings fit the 10-minute window at a 60 s poll; nine of them form the mean.
    expect(vital.sampleCount).toBe(10);
    expect(vital.baselineCount).toBe(9);
  });

  it('never lets the current reading into its own average', () => {
    // The self-reference bug, in the direction that makes it visible. Including the newest
    // sample would pull the mean to 92 and report a 118 % rise instead of a 150 % one — an
    // error that shrinks as the window grows, so it would look like rounding at 600 samples
    // and like nonsense at four. 200 bpm is a tachycardia flag; that is the other card's
    // business, and the average must be untouched by it either way.
    const vital = baselinesFor(windowOf({ cadenceMs: 60 * SECOND, hr: 80, currentHr: 200 }))
      .vitals[HR];

    expect(vital.baseline).toBe(80);
    expect(vital.delta).toBe(120);
  });

  it('describes the newest reading rather than waiting for a sustained run', () => {
    // A deliberate departure from every rule in the engine, which all require duration. The
    // Dashboard prints that same newest reading in 28-point type directly above this line, so
    // a row that waited for confirmation would sit there saying "in line" beside a number the
    // user can plainly see has moved. Self-contradiction is the worse failure; the deadband,
    // not a duration, is what keeps noise out.
    const vital = baselinesFor(windowOf({ cadenceMs: 60 * SECOND, hr: 80, currentHr: 92 }))
      .vitals[HR];

    expect(vital.meaningful).toBe(true);
    expect(vital.current).toBe(92);
  });
});

describe('the deadband is the only thing that decides whether the row speaks', () => {
  const cadenceMs = 60 * SECOND;

  it('reports a difference exactly at the deadband, and stays quiet one bpm under', () => {
    // Inclusive `>=`, asserted from both sides. The pair is what holds the boundary in place:
    // either comparison alone passes with the wrong operator.
    const exact = baselinesFor(
      windowOf({ cadenceMs, hr: 100, currentHr: 100 + baseline.minDeltaBpm }),
    ).vitals[HR];
    expect(exact.meaningful).toBe(true);
    expect(exact.short).toBe('+7%');

    const under = baselinesFor(
      windowOf({ cadenceMs, hr: 100, currentHr: 100 + baseline.minDeltaBpm - 1 }),
    ).vitals[HR];
    expect(under.meaningful).toBe(false);
    expect(under.short).toBe('In line');
  });

  it('applies the same boundary below the average', () => {
    const vital = baselinesFor(
      windowOf({ cadenceMs, hr: 100, currentHr: 100 - baseline.minDeltaBpm }),
    ).vitals[HR];

    expect(vital.direction).toBe('below');
    expect(vital.short).toBe('-7%');
    expect(vital.summary).toBe('Heart rate is 7% below your 10-minute average.');
  });

  it('ranks vitals by deadband widths, not by the size of the raw number', () => {
    // 8 bpm against a 7 bpm deadband is 1.1 widths; 4 points against a 2-point deadband is
    // 2.0. The headline has to pick the SpO₂ drop even though 8 is twice 4, because the two
    // numbers are in different units and comparing them directly is meaningless. Sorting by
    // raw magnitude would let skin temperature — which moves in tenths — never win at all.
    const result = baselinesFor(
      windowOf({ cadenceMs, hr: 80, currentHr: 88, spo2: 98, currentSpo2: 94 }),
    );

    expect(result.vitals[HR].meaningful).toBe(true);
    expect(result.vitals[SPO2].meaningful).toBe(true);
    expect(result.vitals[HR].noiseMultiple).toBeLessThan(result.vitals[SPO2].noiseMultiple);
    expect(result.headline).toBe('SpO₂ is 4 points below your 10-minute average.');
  });

  it('says nothing is out of line when every vital is inside its deadband', () => {
    const result = baselinesFor(windowOf({ cadenceMs, hr: 80 }));

    // Deliberately not "all three vitals": a device missing a sensor has fewer, and the
    // sentence must not claim coverage the readings cannot back.
    expect(result.headline).toBe('In line with your 10-minute average.');
  });
});

describe('each vital is reported in the unit that means something for it', () => {
  const cadenceMs = 60 * SECOND;

  it('reports heart rate as a percentage of its own average', () => {
    // bpm is a ratio scale with a true zero, so a percentage is a real quantity here — and it
    // is the one form that reads the same for a trained adult resting at 52 and a patient
    // resting at 84.
    const vital = baselinesFor(windowOf({ cadenceMs, hr: 80, currentHr: 92 })).vitals[HR];

    expect(vital.percentDelta).toBe(15);
    expect(vital.report).toBe('percent');
    expect(vital.unit).toBe('bpm');
  });

  it('reports SpO₂ in percentage points and never as a percent of a percent', () => {
    // "3 % below 98 %" invites the reader to compute 2.94 and land on the wrong number. The
    // difference between 98 and 95 is three points, and `percentDelta` stays null so no
    // consumer can render it the other way by reaching for a field that happens to be there.
    const vital = baselinesFor(windowOf({ cadenceMs, spo2: 98, currentSpo2: 95 })).vitals[SPO2];

    expect(vital.percentDelta).toBeNull();
    expect(vital.report).toBe('points');
    expect(vital.delta).toBe(-3);
    expect(vital.short).toBe('-3 pts');
    expect(vital.summary).toBe('SpO₂ is 3 points below your 10-minute average.');
  });

  it('says "point" rather than "points" when the difference is one', () => {
    // Only reachable by lowering the deadband to its floor, which is exactly where the
    // singular case lives. A stray plural is small, but it is the kind of detail that makes a
    // health app read as machine-generated.
    const vital = baselinesFor(windowOf({ cadenceMs, spo2: 98, currentSpo2: 97 }), {
      baseline: { minDeltaSpo2Pct: 1 },
    }).vitals[SPO2];

    expect(vital.summary).toBe('SpO₂ is 1 point below your 10-minute average.');
  });

  it('reports skin temperature in degrees, never as a percentage', () => {
    // °C is an interval scale — its zero is a convention, not an absence of heat — so "1 %
    // above 34 °C" is not 0.34 °C of anything, and the same physical rise in °F would come out
    // as a different percentage.
    const vital = baselinesFor(windowOf({ cadenceMs, skinTempC: 34, currentSkinTempC: 34.4 }))
      .vitals[SKIN];

    expect(vital.percentDelta).toBeNull();
    expect(vital.report).toBe('degrees');
    expect(vital.short).toBe('+0.4°C');
    expect(vital.summary).toBe('Skin temp is 0.4°C above your 10-minute average.');
  });

  it('holds each vital to its own deadband rather than a shared one', () => {
    // 0.4 °C speaks while 4 bpm does not, in the same window. A single shared threshold would
    // have to be wrong for at least two of the three.
    const result = baselinesFor(
      windowOf({ cadenceMs, hr: 80, currentHr: 84, skinTempC: 34, currentSkinTempC: 34.4 }),
    );

    expect(result.vitals[HR].meaningful).toBe(false);
    expect(result.vitals[SKIN].meaningful).toBe(true);
  });
});

describe('what the row says when the evidence is thin', () => {
  const cadenceMs = 60 * SECOND;

  it('declines to average two readings, and names the reason', () => {
    // `minBaselineSamples` is 3 *behind* the current value, so four readings are the minimum
    // and three are one short. A "rolling average" of two points is a second reading with
    // extra ceremony.
    const result = baselinesFor(windowOf({ cadenceMs, spanMs: 3 * MINUTE, hr: 80, currentHr: 92 }));

    expect(result.vitals[HR].baseline).toBeNull();
    expect(result.vitals[HR].baselineCount).toBe(2);
    expect(result.vitals[HR].short).toBe('—');
    expect(result.vitals[HR].dataQuality).toBe('partial');
    expect(result.vitals[HR].summary).toBe('Not enough readings yet for a heart-rate baseline.');
    expect(result.headline).toBe(
      'Not enough readings yet to compare against your 10-minute average.',
    );
  });

  it('speaks as soon as the third baseline sample arrives', () => {
    // The other side of the same boundary, one poll later.
    const vital = baselinesFor(windowOf({ cadenceMs, spanMs: 4 * MINUTE, hr: 80, currentHr: 92 }))
      .vitals[HR];

    expect(vital.baselineCount).toBe(3);
    expect(vital.baseline).toBe(80);
    expect(vital.short).toBe('+15%');
    expect(vital.dataQuality).toBe('ok');
  });

  it('reports `missing` when the vital is absent rather than inventing a zero', () => {
    // The standing rule for this engine: absent stays absent. A substituted 0 would read as
    // an average heart rate of zero and a −100 % delta.
    const motionOnly = windowOf({ cadenceMs }).map((sample) =>
      reading({ at: sample.timestamp, motionSummary: stillMotion() }),
    );
    const vital = baselinesFor(motionOnly).vitals[HR];

    expect(vital.current).toBeNull();
    expect(vital.baseline).toBeNull();
    expect(vital.dataQuality).toBe('missing');
    expect(vital.summary).toBe('No heart-rate readings to average.');
  });

  it('distinguishes "no readings" from "readings the gate threw out"', () => {
    // Both leave nothing to average, and they are different problems: one is a sensor that
    // has not reported, the other is a sensor reporting nonsense. A single shared sentence
    // would hide the second inside the first.
    const impossible = windowOf({ cadenceMs }).map((sample) =>
      reading({ at: sample.timestamp, hr: plausible.hr.max + 100 }),
    );
    const vital = baselinesFor(impossible).vitals[HR];

    expect(vital.dataQuality).toBe('missing');
    expect(vital.summary).toBe(
      'Recent heart-rate readings were unusable, so there is no average to compare against.',
    );
  });

  it('keeps an impossible reading out of the average and says the data was partial', () => {
    // A 400 bpm artifact in the middle of the window. If the plausibility gate were bypassed
    // the mean would jump to 116 and the row would report the user as 21 % *below* their own
    // average while their heart rate was flat — a sign error produced entirely by one bad
    // sample.
    const poisoned = windowOf({ cadenceMs, hr: 80, currentHr: 92 }).map((sample, index) =>
      index === 4 ? { ...sample, hr: 400 } : sample,
    );
    const vital = baselinesFor(poisoned).vitals[HR];

    expect(vital.baseline).toBe(80);
    expect(vital.short).toBe('+15%');
    expect(vital.dataQuality).toBe('partial');
    expect(vital.sampleCount).toBe(9);
  });

  it('stops claiming a deviation once the newest reading has aged out', () => {
    // The "current" half of the comparison is no longer current, so the row goes quiet — but
    // the numbers stay on the object, because a consumer that wants to show the last known
    // difference should be able to, and because deleting them would make this state
    // indistinguishable from a missing sensor.
    const vital = baselinesFor(
      windowOf({ cadenceMs, lagMs: window.maxStaleMs + cadenceMs, hr: 80, currentHr: 92 }),
    ).vitals[HR];

    expect(vital.dataQuality).toBe('stale');
    expect(vital.meaningful).toBe(false);
    expect(vital.short).toBe('—');
    expect(vital.summary).toBe('Recent heart-rate readings are out of date.');
    expect(vital.delta).toBe(12);
  });
});

describe('the window is the assessment’s, never one of its own', () => {
  const cadenceMs = 60 * SECOND;

  it('takes the span and the instant straight from the assessment it was given', () => {
    // The property the signature exists for. Resolving its own `now` would let the row and the
    // cards above it describe different stretches of time with nothing saying so.
    const readings = windowOf({ cadenceMs });
    const assessment = assessRisk({ readings, environment: COMFORTABLE, now: at(0) });
    const result = computeVitalBaselines({ readings, assessment });

    expect(result.windowMs).toBe(assessment.windowMs);
    expect(result.evaluatedAt).toBe(assessment.evaluatedAt);
  });

  it('names the horizon from the configured window instead of spelling it out', () => {
    // The whole reason the label is derived: widen the window and every sentence follows. A
    // hardcoded "10-minute" would keep saying 10 while averaging 20, which is a lie the user
    // has no way to detect.
    const result = baselinesFor(windowOf({ cadenceMs, hr: 80, currentHr: 92 }), {
      window: { ms: 20 * MINUTE },
    });

    expect(result.windowLabel).toBe('20-minute');
    expect(result.vitals[HR].summary).toBe('Heart rate is 15% above your 20-minute average.');
    expect(result.headline).toBe('Heart rate is 15% above your 20-minute average.');
  });

  it('ignores readings older than the window it is describing', () => {
    // "Your 10-minute average" has to be an average of ten minutes. A buffer longer than the
    // window is the normal case — `dehydration` and `fatigue` read 15 and 18 minutes of it —
    // so the trailing edge is load-bearing, not theoretical.
    const older = windowOf({ cadenceMs, hr: 200, spanMs: 15 * MINUTE }).filter(
      (sample) => sample.timestamp <= at(-window.ms),
    );
    const vital = baselinesFor([...older, ...windowOf({ cadenceMs, hr: 80, currentHr: 92 })])
      .vitals[HR];

    expect(vital.baseline).toBe(80);
    expect(vital.sampleCount).toBe(10);
  });

  it('drops a future-dated reading rather than treating it as current', () => {
    // Clock skew between a peripheral and the phone produces these, and a reading from the
    // future would otherwise become the "current" value the whole comparison is built on.
    const skewed = [
      ...windowOf({ cadenceMs, hr: 80, currentHr: 92 }),
      reading({ at: at(60 * SECOND), hr: 200, motionSummary: stillMotion() }),
    ];
    const vital = baselinesFor(skewed).vitals[HR];

    expect(vital.current).toBe(92);
    expect(vital.baseline).toBe(80);
  });
});

describe('formatWindowLabel', () => {
  it('reads a whole-minute window as minutes', () => {
    expect(formatWindowLabel(window.ms)).toBe('10-minute');
    expect(formatWindowLabel(20 * MINUTE)).toBe('20-minute');
  });

  it('falls back to seconds below a minute rather than saying "0-minute"', () => {
    expect(formatWindowLabel(45 * SECOND)).toBe('45-second');
  });

  it('degrades to a vague word rather than a nonsense number', () => {
    // Reachable only by a caller passing garbage, and "your recent average" is still a true
    // sentence — which is the right failure for a string the user reads.
    expect(formatWindowLabel(0)).toBe('recent');
    expect(formatWindowLabel(Number.NaN)).toBe('recent');
  });
});

describe('the baseline config cannot be turned into a permanently silent row', () => {
  /** The most baseline samples reachable at the widest gap the engine calls continuous, with
   *  one of the window's readings spent being the current value. */
  const reachableBaselineSamples = Math.floor(window.ms / window.maxGapMs);

  it('ships defaults that already satisfy their own floors', () => {
    // `resolveRiskThresholds` returns the defaults untouched when there are no overrides, so
    // anything that depended on the clamps below would never be clamped in production.
    expect(baseline.minBaselineSamples).toBeLessThanOrEqual(reachableBaselineSamples);
    expect(baseline.minDeltaBpm).toBeLessThanOrEqual(dehydration.riseBpm);
    expect(baseline.minDeltaBpm).toBeGreaterThanOrEqual(plausible.hr.max / 100);
    expect(baseline.minDeltaSpo2Pct).toBeGreaterThanOrEqual(1);
    expect(baseline.minDeltaSkinTempC).toBeGreaterThanOrEqual(0.1);
  });

  it('clamps a sample floor the cadence could never reach', () => {
    expect(
      resolveRiskThresholds({ baseline: { minBaselineSamples: 99 } }).baseline.minBaselineSamples,
    ).toBe(reachableBaselineSamples);
  });

  it('keeps at least one sample in the average', () => {
    expect(
      resolveRiskThresholds({ baseline: { minBaselineSamples: 0 } }).baseline.minBaselineSamples,
    ).toBe(1);
  });

  it('clamps a deadband coarser than the smallest rise any rule treats as significant', () => {
    // Without this the row could be configured to stay silent while the dehydration card
    // reported a 22 bpm rise beside it — for no reason other than the deadband. Note what is
    // *not* claimed: the two read different horizons, so they can legitimately disagree.
    expect(resolveRiskThresholds({ baseline: { minDeltaBpm: 500 } }).baseline.minDeltaBpm).toBe(
      dehydration.riseBpm,
    );
  });

  it('clamps a deadband so fine that a reported difference would round to zero', () => {
    // "Heart rate is 0% above your 10-minute average" is grammatical, confident, and empty.
    const resolved = resolveRiskThresholds({ baseline: { minDeltaBpm: 0 } }).baseline;

    expect(resolved.minDeltaBpm).toBe(plausible.hr.max / 100);
    // The invariant that floor buys, stated directly: at the widest baseline the plausibility
    // gate admits, any reportable difference is still at least one whole percent.
    expect((resolved.minDeltaBpm / plausible.hr.max) * 100).toBeGreaterThanOrEqual(1);
  });

  it('tracks the plausible range when that is what was widened', () => {
    // The floor is derived rather than written down, so a caller who admits heart rates up to
    // 1000 bpm gets a deadband that still renders — 10 bpm is 1 % of 1000.
    expect(
      resolveRiskThresholds({ plausible: { hr: { min: 20, max: 1000 } } }).baseline.minDeltaBpm,
    ).toBe(10);
  });

  it('lets the renderable floor win when the two clamps conflict', () => {
    // Reachable only by pushing `dehydration.riseBpm` into the noise floor as well. A
    // slightly-too-coarse deadband is a judgement call; a card printing a zero and calling it
    // a finding is a defect, so the floor takes precedence.
    const resolved = resolveRiskThresholds({
      baseline: { minDeltaBpm: 1 },
      dehydration: { riseBpm: 1 },
    }).baseline;

    expect(resolved.minDeltaBpm).toBe(plausible.hr.max / 100);
    expect(resolved.minDeltaBpm).toBeGreaterThan(1);
  });

  it('clamps the other two deadbands to the finest step the row can print', () => {
    const resolved = resolveRiskThresholds({
      baseline: { minDeltaSpo2Pct: 0, minDeltaSkinTempC: 0 },
    }).baseline;

    expect(resolved.minDeltaSpo2Pct).toBe(1);
    expect(resolved.minDeltaSkinTempC).toBe(0.1);
  });

  it('repairs rather than throws, so a bad override degrades instead of crashing', () => {
    // `computeVitalBaselines` runs on every sensor tick beside `assessRisk`; a throw here
    // would take the Dashboard down, which is the one genuinely unacceptable response.
    expect(() =>
      resolveRiskThresholds({
        baseline: {
          minBaselineSamples: -5,
          minDeltaBpm: -1,
          minDeltaSpo2Pct: -1,
          minDeltaSkinTempC: -1,
        },
      }),
    ).not.toThrow();
  });

  it('still reports a deviation after a hostile override has been repaired', () => {
    // Repair is only worth anything if the repaired configuration works.
    const override: PartialRiskThresholds = { baseline: { minBaselineSamples: 99 } };
    const vital = baselinesFor(
      windowOf({ cadenceMs: 60 * SECOND, hr: 80, currentHr: 92 }),
      override,
    ).vitals[HR];

    expect(vital.short).toBe('+15%');
  });
});

describe('a deviation is a description, not a seventh risk signal', () => {
  const readings = windowOf({ cadenceMs: 60 * SECOND, hr: 80, currentHr: 92 });
  const assessment = assessRisk({ readings, environment: COMFORTABLE, now: at(0) });
  const result = computeVitalBaselines({ readings, assessment });

  it('reports a 15% rise', () => {
    expect(result.vitals[HR].short).toBe('+15%');
  });

  it('is not part of the assessment', () => {
    // Structural, not stylistic. The moment a baseline lands on `RiskAssessment`, something
    // downstream starts branching on it, and an undocumented rule exists.
    expect(assessment).not.toHaveProperty('baselines');
    expect(assessment).not.toHaveProperty('vitals');
  });

  it('fires no rule, raises no flag, and triggers no SOS', () => {
    expect(assessment.flaggedRules).toEqual([]);
    expect(assessment.criticalRules).toEqual([]);
    expect(assessment.sosCandidate).toBe(false);
  });

  it('leaves every category at green', () => {
    for (const category of assessment.categories) {
      expect(category.level).toBe('green');
    }
  });
});
