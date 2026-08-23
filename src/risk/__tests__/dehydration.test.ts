/**
 * Dehydration advisory (PRD §7.2.4 extension) — behaviour, boundaries, and reachability at
 * the polling cadence PRD §7.2.1 actually specifies.
 *
 * ## Why the cadence grid is here and not optional
 * This engine has shipped four thresholds that were mathematically unsatisfiable at a
 * 30–60 s poll interval while a green test suite sampled them at 1 Hz. The failure mode is
 * always the same and always silent: a duration rule whose window cannot physically contain
 * the span it demands simply never fires, and nothing anywhere says so. This rule adds a
 * fifth opportunity for it — the baseline segment eats the oldest 40 % of the window, so the
 * drift run has only the remainder to live in — so the reachability is asserted directly at
 * every cadence rather than argued for in a comment.
 *
 * ## Why a baseline instead of a number, asserted rather than asserted-about
 * The design claim is that measuring the *rise* rather than the value is what lets one rule
 * serve an athlete resting at 50 bpm and a patient resting at 84. "Two people, same drift,
 * same verdict; two people, same heart rate, different verdict" is the pair that proves it,
 * and it is the first thing a threshold rewrite would break.
 *
 * ## Both directions of every guard
 * A test that only shows the rule firing cannot distinguish "correct" from "fires on
 * anything". Each gate here has a companion showing that removing it lets an everyday
 * situation through: heat exposure without drift, drift without heat, drift during exertion,
 * and — for the rest gate specifically — the same walk firing once the gate is loosened.
 */

import { assessRisk } from '../assess';
import { DEFAULT_RISK_THRESHOLDS, resolveRiskThresholds } from '../config';
import { fahrenheitToCelsius, HEAT_INDEX_BAND_MIN_F } from '../heat-index';
import type {
  EnvironmentSnapshot,
  MotionSummary,
  PartialRiskThresholds,
  SensorReading,
} from '../types';
import { activeMotion, at, MINUTE, reading, SECOND, stillMotion } from './fixtures';

const { dehydration, window } = DEFAULT_RISK_THRESHOLDS;

/** Build an environment whose heat index is exactly `heatIndexF`, so band boundaries are
 *  exact rather than approximate. */
function envAtHeatIndexF(heatIndexF: number): EnvironmentSnapshot {
  return { tempC: 30, humidity: 50, heatIndexC: fahrenheitToCelsius(heatIndexF) };
}

/** Inside NOAA's Extreme Caution band: past `exposureMinF`, short of the Danger flag. */
const EXTREME_CAUTION = envAtHeatIndexF(95);
/** Inside the Danger band, which is what the severe tier additionally requires. */
const DANGER = envAtHeatIndexF(110);
/** Normal band — heat contributes nothing. */
const MILD = envAtHeatIndexF(75);

/**
 * Fraction of the window, measured back from `now`, over which the elevated heart rate is
 * present. 0.55 sits inside the newest `1 − baselineFraction` (0.6) of the window at every
 * cadence under test, so the elevation lands in the drift slice and not in the baseline —
 * without the fixture having to reproduce the engine's count-based split arithmetic.
 */
const DRIFT_SPAN_FRACTION = 0.55;

type DriftOptions = {
  readonly cadenceMs: number;
  readonly baselineHr: number;
  readonly driftHr: number;
  readonly motion?: MotionSummary;
  /** Overrides {@link DRIFT_SPAN_FRACTION} for the tests that probe the duration gate. */
  readonly driftMs?: number;
  readonly spanMs?: number;
};

/**
 * A full dehydration window at `cadenceMs`: `baselineHr` throughout, rising to `driftHr`
 * over the trailing stretch. Sampled from `now` backwards, because every rule is anchored
 * to now and that is the end whose alignment matters.
 */
function driftSeries(options: DriftOptions): SensorReading[] {
  const spanMs = options.spanMs ?? dehydration.windowMs;
  const driftMs = options.driftMs ?? spanMs * DRIFT_SPAN_FRACTION;
  const motion = options.motion ?? stillMotion();
  const readings: SensorReading[] = [];

  for (let offset = 0; offset < spanMs; offset += options.cadenceMs) {
    readings.push(
      reading({
        at: at(-offset),
        hr: offset < driftMs ? options.driftHr : options.baselineHr,
        spo2: 98,
        motionSummary: motion,
      }),
    );
  }

  return readings.reverse();
}

function assess(
  readings: readonly SensorReading[],
  environment: EnvironmentSnapshot,
  thresholds?: PartialRiskThresholds,
) {
  return assessRisk({ readings, environment, now: at(0), thresholds }).byCategory.dehydration;
}

describe('the drift rule is reachable at every polling cadence PRD §7.2.1 allows', () => {
  // 30 s and 60 s are the spec'd range. 1–10 s are the rates this suite historically used
  // exclusively, kept so a regression reads as a narrowing rather than a flip.
  const CADENCES = [1 * SECOND, 5 * SECOND, 10 * SECOND, 30 * SECOND, 60 * SECOND];

  it.each(CADENCES)('reports drift in the heat when sampled every %ims', (cadenceMs) => {
    const result = assess(
      driftSeries({ cadenceMs, baselineHr: 72, driftHr: 85 }),
      EXTREME_CAUTION,
    );
    expect(result.firedRules).toEqual(['dehydration.cardiovascularDrift']);
    expect(result.level).toBe('amber');
    expect(result.dataQuality).toBe('ok');
  });

  it.each(CADENCES)('reports the severe tier in the Danger band at %ims', (cadenceMs) => {
    const result = assess(driftSeries({ cadenceMs, baselineHr: 72, driftHr: 95 }), DANGER);
    expect(result.firedRules).toContain('dehydration.cardiovascularDrift.severe');
    expect(result.level).toBe('red');
  });

  it.each(CADENCES)('stays green on a steady heart rate in the same heat, at %ims', (cadenceMs) => {
    // The negative half of the grid. Without it, a rule that fired on heat exposure alone
    // would pass every assertion above.
    const result = assess(
      driftSeries({ cadenceMs, baselineHr: 72, driftHr: 72 }),
      EXTREME_CAUTION,
    );
    expect(result.firedRules).toEqual([]);
    expect(result.level).toBe('green');
    expect(result.score).toBe(0);
  });

  it('needs the drift to outlast `sustainedForMs`, not merely to be present', () => {
    const cadenceMs = 60 * SECOND;
    // `trailingRun` measures the span from the oldest *armed* sample, so it under-reads the
    // true duration by up to one interval — at 60 s a 5-minute requirement needs six armed
    // readings. A drift of exactly `sustainedForMs` therefore must not fire.
    const brief = assess(
      driftSeries({ cadenceMs, baselineHr: 72, driftHr: 85, driftMs: dehydration.sustainedForMs }),
      EXTREME_CAUTION,
    );
    expect(brief.firedRules).toEqual([]);

    const long = assess(
      driftSeries({
        cadenceMs,
        baselineHr: 72,
        driftHr: 85,
        driftMs: dehydration.sustainedForMs + 2 * cadenceMs,
      }),
      EXTREME_CAUTION,
    );
    expect(long.firedRules).toEqual(['dehydration.cardiovascularDrift']);
  });
});

describe('the rise is measured against the user’s own baseline, not an absolute number', () => {
  const cadenceMs = 60 * SECOND;

  it('reports the same drift for a trained adult and for a patient with a high resting rate', () => {
    // 13 bpm of drift either way. An absolute threshold cannot report both: any number that
    // catches the athlete's 63 bpm has already been firing on the patient's 84 all day.
    const athlete = assess(
      driftSeries({ cadenceMs, baselineHr: 50, driftHr: 63 }),
      EXTREME_CAUTION,
    );
    const patient = assess(
      driftSeries({ cadenceMs, baselineHr: 84, driftHr: 97 }),
      EXTREME_CAUTION,
    );

    expect(athlete.firedRules).toEqual(['dehydration.cardiovascularDrift']);
    expect(patient.firedRules).toEqual(['dehydration.cardiovascularDrift']);
    expect(athlete.score).toBe(patient.score);
  });

  it('stays silent for a high but steady resting rate', () => {
    // The other half of the same property. 84 bpm in the heat is not dehydration; 84 bpm
    // that used to be 71 is the thing this rule exists to notice.
    const steady = assess(driftSeries({ cadenceMs, baselineHr: 84, driftHr: 84 }), EXTREME_CAUTION);
    expect(steady.firedRules).toEqual([]);
    expect(steady.level).toBe('green');
  });

  it('names the baseline in the metric, so the number on the card can be checked', () => {
    const result = assess(driftSeries({ cadenceMs, baselineHr: 72, driftHr: 85 }), EXTREME_CAUTION);
    expect(result.metric).toBe('HR +13 bpm vs baseline 72');
  });
});

describe('boundaries', () => {
  const cadenceMs = 60 * SECOND;
  const driftAt = (driftHr: number, environment: EnvironmentSnapshot) =>
    assess(driftSeries({ cadenceMs, baselineHr: 72, driftHr }), environment);

  it('treats `riseBpm` as strict, so a rise of exactly that much does not fire', () => {
    expect(driftAt(72 + dehydration.riseBpm, EXTREME_CAUTION).firedRules).toEqual([]);
    expect(driftAt(72 + dehydration.riseBpm + 1, EXTREME_CAUTION).firedRules).toEqual([
      'dehydration.cardiovascularDrift',
    ]);
  });

  it('treats `exposureMinF` as inclusive, so the band floor itself counts as exposure', () => {
    // Inclusive because the value is a published band floor: 90 °F *is* Extreme Caution,
    // and excluding it would silently move the rule's exposure gate up by one degree.
    expect(driftAt(85, envAtHeatIndexF(dehydration.exposureMinF)).firedRules).toEqual([
      'dehydration.cardiovascularDrift',
    ]);
    expect(driftAt(85, envAtHeatIndexF(dehydration.exposureMinF - 0.1)).firedRules).toEqual([]);
  });

  it('treats `severeRiseBpm` as inclusive and requires the Danger band with it', () => {
    const severe = driftAt(72 + dehydration.severeRiseBpm, DANGER);
    expect(severe.firedRules).toContain('dehydration.cardiovascularDrift.severe');

    // One bpm short: still drift, no longer severe.
    expect(driftAt(72 + dehydration.severeRiseBpm - 1, DANGER).firedRules).toEqual([
      'dehydration.cardiovascularDrift',
    ]);

    // Same drift, one tenth of a degree below the Danger floor: the severe tier needs both
    // halves at strength, so this stays amber rather than escalating on the rise alone.
    const belowDanger = driftAt(
      72 + dehydration.severeRiseBpm,
      envAtHeatIndexF(HEAT_INDEX_BAND_MIN_F.danger - 0.1),
    );
    expect(belowDanger.firedRules).toEqual(['dehydration.cardiovascularDrift']);
    expect(belowDanger.level).toBe('amber');
  });

  it('scores the Danger band worse than Extreme Caution at identical drift', () => {
    const caution = driftAt(85, EXTREME_CAUTION);
    const danger = driftAt(85, DANGER);
    expect(danger.score).toBeGreaterThan(caution.score);
    expect(caution.level).toBe('amber');
    expect(danger.level).toBe('amber');
  });
});

describe('what the rule refuses to fire on', () => {
  const cadenceMs = 60 * SECOND;

  it('ignores drift with no heat load — that is the cardiovascular rule’s business', () => {
    const result = assess(driftSeries({ cadenceMs, baselineHr: 72, driftHr: 95 }), MILD);
    expect(result.firedRules).toEqual([]);
    expect(result.guidance).toBe('No signs of heat-related fluid loss.');
  });

  it('ignores drift during exertion, which is ordinary physiology', () => {
    const result = assess(
      driftSeries({ cadenceMs, baselineHr: 72, driftHr: 95, motion: activeMotion() }),
      DANGER,
    );
    expect(result.firedRules).toEqual([]);
  });

  it('would fire on that same exertion if the rest gate were removed', () => {
    // The coupling, asserted so the gate cannot be loosened without a test objecting.
    // `minRestFraction: 0` makes any observed motion count as rest, which is what a
    // well-meaning "the rule never fires, let's relax it" edit looks like.
    const result = assess(
      driftSeries({ cadenceMs, baselineHr: 72, driftHr: 95, motion: activeMotion() }),
      DANGER,
      { heartRate: { minRestFraction: 0 } },
    );
    expect(result.firedRules).toContain('dehydration.cardiovascularDrift');
  });

  it('reports heat exposure without pretending to know about fluid loss', () => {
    const result = assess(driftSeries({ cadenceMs, baselineHr: 72, driftHr: 72 }), DANGER);
    expect(result.level).toBe('green');
    expect(result.guidance).toBe(
      'Heat exposure is high but your heart rate is steady — keep drinking water.',
    );
  });

  it('declines to judge before there is weather, rather than assuming comfort', () => {
    const result = assessRisk({
      readings: driftSeries({ cadenceMs, baselineHr: 72, driftHr: 95 }),
      environment: null,
      now: at(0),
    }).byCategory.dehydration;
    expect(result.dataQuality).toBe('missing');
    expect(result.level).toBe('green');
    expect(result.metric).toBe('Hydration —');
    expect(result.guidance).not.toMatch(/no signs|steady/i);
  });

  it('says the baseline is pending rather than comparing against one point', () => {
    const thin: SensorReading[] = [
      reading({ at: at(-2 * MINUTE), hr: 72, motionSummary: stillMotion() }),
      reading({ at: at(-MINUTE), hr: 88, motionSummary: stillMotion() }),
      reading({ at: at(0), hr: 95, motionSummary: stillMotion() }),
    ];
    const result = assess(thin, DANGER);
    expect(result.firedRules).toEqual([]);
    expect(result.dataQuality).toBe('partial');
    expect(result.metric).toBe('HR 95 bpm, baseline pending');
  });
});

describe('the advisory cannot escalate itself into a flag or an SOS', () => {
  const cadenceMs = 60 * SECOND;
  const severe = assessRisk({
    readings: driftSeries({ cadenceMs, baselineHr: 72, driftHr: 100 }),
    environment: DANGER,
    now: at(0),
  });

  it('reports red without setting `flagged`', () => {
    expect(severe.byCategory.dehydration.level).toBe('red');
    expect(severe.byCategory.dehydration.flagged).toBe(false);
    expect(severe.flaggedRules).not.toContain('dehydration.cardiovascularDrift.severe');
  });

  it('contributes nothing to the SOS trigger set', () => {
    expect(severe.byCategory.dehydration.criticalRules).toEqual([]);
    expect(severe.byCategory.dehydration.critical).toBe(false);
    expect(severe.criticalRules).not.toContain('dehydration.cardiovascularDrift.severe');
  });

  it('scores below the band the specified flags reserve for themselves', () => {
    // `heat.index.extremeDanger` scores 90+. An advisory that could outscore it would
    // outrank a mandated flag in any consumer that sorts by score.
    expect(severe.byCategory.dehydration.score).toBeLessThan(90);
  });

  it('applies no environmental multiplier, because heat is already half the rule', () => {
    // Amplifying by the heat flag as well would count the same evidence twice in the
    // fusion layer.
    expect(severe.byCategory.dehydration.envMultiplier).toBe(1);
  });
});

describe('the dehydration window cannot be configured into an unsatisfiable state', () => {
  /** The floor the window has to clear: the run lives in the newest `1 − fraction` of it. */
  const floorFor = (sustainedForMs: number, baselineFraction: number, maxGapMs: number) =>
    Math.ceil((sustainedForMs + maxGapMs) / (1 - baselineFraction));

  it('ships a default that already satisfies its own floor', () => {
    // `resolveRiskThresholds` returns the defaults untouched when there are no overrides,
    // so the shipped values must be self-consistent rather than rely on repair.
    expect(dehydration.windowMs).toBeGreaterThanOrEqual(
      floorFor(dehydration.sustainedForMs, dehydration.baselineFraction, window.maxGapMs),
    );
    expect(dehydration.riseReleaseBpm).toBeLessThanOrEqual(dehydration.riseBpm);
    expect(dehydration.severeRiseBpm).toBeGreaterThanOrEqual(dehydration.riseBpm);
    expect(dehydration.baselineFraction).toBeGreaterThan(0);
    expect(dehydration.baselineFraction).toBeLessThan(1);
  });

  it('widens a window the baseline would leave no room in', () => {
    const resolved = resolveRiskThresholds({ dehydration: { windowMs: 2 * MINUTE } });
    expect(resolved.dehydration.windowMs).toBe(
      floorFor(dehydration.sustainedForMs, dehydration.baselineFraction, window.maxGapMs),
    );
  });

  it('scales the floor with the configured baseline share', () => {
    // A larger baseline share leaves less room for the run, so the window must grow.
    const resolved = resolveRiskThresholds({
      dehydration: { baselineFraction: 0.75, windowMs: MINUTE },
    });
    expect(resolved.dehydration.windowMs).toBe(
      floorFor(dehydration.sustainedForMs, 0.75, window.maxGapMs),
    );
    expect(resolved.dehydration.windowMs).toBeGreaterThan(dehydration.windowMs);
  });

  it('scales the floor with the configured drift duration', () => {
    const resolved = resolveRiskThresholds({
      dehydration: { sustainedForMs: 20 * MINUTE, windowMs: MINUTE },
    });
    expect(resolved.dehydration.windowMs).toBe(
      floorFor(20 * MINUTE, dehydration.baselineFraction, window.maxGapMs),
    );
  });

  it('clamps a baseline share of 1, which would consume the entire window', () => {
    // The pathological value, and the reason the clamp exists rather than a comment: at 1.0
    // there is no drift slice at all and the floor computation divides by zero.
    const resolved = resolveRiskThresholds({ dehydration: { baselineFraction: 1 } });
    expect(resolved.dehydration.baselineFraction).toBeLessThan(1);
    expect(Number.isFinite(resolved.dehydration.windowMs)).toBe(true);
  });

  it('clamps a baseline share of 0, which would leave no baseline to compare against', () => {
    const resolved = resolveRiskThresholds({ dehydration: { baselineFraction: 0 } });
    expect(resolved.dehydration.baselineFraction).toBeGreaterThan(0);
  });

  it('clamps a release threshold above its arm threshold', () => {
    // Same trap as `tachycardiaReleaseAbove`: a reading that arms the run would fail to
    // hold it, silently raising the effective rise threshold.
    const resolved = resolveRiskThresholds({ dehydration: { riseReleaseBpm: 50 } });
    expect(resolved.dehydration.riseReleaseBpm).toBe(dehydration.riseBpm);
  });

  it('clamps a severe threshold below its arm threshold', () => {
    // The mirror image: a severe threshold under the mild one makes every drift severe,
    // which is a red card on 10 bpm.
    const resolved = resolveRiskThresholds({ dehydration: { severeRiseBpm: 1 } });
    expect(resolved.dehydration.severeRiseBpm).toBe(dehydration.riseBpm);
  });

  it('leaves a window that is already wide enough alone', () => {
    const generous = 45 * MINUTE;
    expect(resolveRiskThresholds({ dehydration: { windowMs: generous } }).dehydration.windowMs)
      .toBe(generous);
  });

  it('repairs rather than throws, so a bad override degrades instead of crashing', () => {
    // `assessRisk` runs on every sensor tick; a throw here would take the monitoring down.
    expect(() =>
      resolveRiskThresholds({
        dehydration: { windowMs: 0, baselineFraction: 1, riseBpm: 0, severeRiseBpm: -5 },
      }),
    ).not.toThrow();
  });

  it('still fires after a hostile override has been repaired', () => {
    // Repair is only worth anything if the repaired configuration still works. Without this
    // every clamp above could be satisfied by a value that happens to disable the rule, and
    // the suite would be asserting the arithmetic rather than the outcome. The fixture is
    // built against the *repaired* window, which is the buffer a real caller would then be
    // feeding: the whole point of widening it is that the extra span gets used.
    const override = { dehydration: { windowMs: SECOND } };
    const resolved = resolveRiskThresholds(override);
    const result = assess(
      driftSeries({
        cadenceMs: 60 * SECOND,
        baselineHr: 72,
        driftHr: 85,
        spanMs: resolved.dehydration.windowMs,
      }),
      DANGER,
      override,
    );
    expect(result.firedRules).toContain('dehydration.cardiovascularDrift');
  });
});
