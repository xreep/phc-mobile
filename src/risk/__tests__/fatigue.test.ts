/**
 * Fatigue advisory (PRD §7.2.4 extension) — the conjunction, its boundaries, and its
 * reachability at the polling cadence PRD §7.2.1 actually specifies.
 *
 * ## Why this file leans so hard on the cadence grid
 * Fatigue is the widest-window rule in the engine: fifteen minutes of unbroken stillness and
 * twelve minutes of elevated pulse, both measured as *spans between samples*. That makes it
 * the most exposed to the failure this codebase has now hit four times — a duration threshold
 * that the sample cadence cannot physically satisfy, producing a permanently green card and a
 * permanently green test suite. `config.ts` argues in a comment that 18 minutes buys a full
 * sample of slack at the worst case; a comment cannot fail, so the worst case is constructed
 * here instead: a 60 s cadence with a 60 s freshness lag, asserted to fire, with the observed
 * stillness span pinned to an exact number of minutes.
 *
 * ## Why the conjunction is asserted from three sides
 * "Still" and "elevated pulse" are each unremarkable on their own — the first describes most
 * of a working day, the second describes a flight of stairs. So the rule is only meaningful if
 * neither half fires alone *and* the pair does. All three are asserted, plus the
 * guard-removal direction: with the stillness requirement dropped, the walking fixture fires,
 * which is what proves the requirement is load-bearing rather than decorative.
 *
 * ## Why the cap is tested and not just documented
 * The whole safety argument for a rule that fires on 90 bpm — well under PRD §7.2.2's 120 bpm
 * flag — is that it can never do more than raise a caution card. `assess.ts` takes the
 * Dashboard's headline from the worst category, so an advisory that reached red would put the
 * app at Alert on evidence amounting to "sitting still with a raised pulse". The cap is
 * therefore asserted at an absurd heart rate, where any missing clamp would show.
 */

import { assessRisk } from '../assess';
import { DEFAULT_RISK_THRESHOLDS, resolveRiskThresholds } from '../config';
import type { EnvironmentSnapshot, PartialRiskThresholds, SensorReading } from '../types';
import { activeMotion, at, MINUTE, reading, SECOND, stillMotion } from './fixtures';

const { fatigue, heartRate, dehydration, window } = DEFAULT_RISK_THRESHOLDS;

/** Nothing in this rule reads the weather; a comfortable snapshot keeps the other cards
 *  quiet so a cross-category assertion means what it says. */
const COMFORTABLE: EnvironmentSnapshot = { tempC: 24, humidity: 50 };

type FatigueOptions = {
  readonly cadenceMs: number;
  /** Heart rate over the trailing `elevatedMs`. */
  readonly hr: number;
  /** Heart rate before that. Defaults to `hr`, i.e. the whole window is elevated. */
  readonly restingHr?: number;
  readonly elevatedMs?: number;
  /**
   * Trailing span the device was motionless for; older readings carry walking motion.
   * Defaults to the whole window. `0` means the user is moving right now, which is what
   * `trailingStillRunMs` reads as no stillness at all.
   */
  readonly stillForMs?: number;
  readonly spanMs?: number;
  /** Age of the newest reading — the freshness lag a real poll always has. */
  readonly lagMs?: number;
};

/**
 * A full fatigue window at `cadenceMs`, built backwards from `now` because that is the end
 * every rule is anchored to and the end whose alignment decides reachability.
 */
function fatigueSeries(options: FatigueOptions): SensorReading[] {
  const spanMs = options.spanMs ?? fatigue.windowMs;
  const lagMs = options.lagMs ?? 0;
  const elevatedMs = options.elevatedMs ?? spanMs;
  const stillForMs = options.stillForMs ?? spanMs;
  const restingHr = options.restingHr ?? options.hr;
  const readings: SensorReading[] = [];

  for (let offset = lagMs; offset < spanMs; offset += options.cadenceMs) {
    readings.push(
      reading({
        at: at(-offset),
        hr: offset < elevatedMs ? options.hr : restingHr,
        spo2: 98,
        motionSummary: offset < stillForMs ? stillMotion() : activeMotion(),
      }),
    );
  }

  return readings.reverse();
}

function assess(readings: readonly SensorReading[], thresholds?: PartialRiskThresholds) {
  return assessRisk({ readings, environment: COMFORTABLE, now: at(0), thresholds }).byCategory
    .fatigue;
}

describe('the fatigue rule is reachable at every polling cadence PRD §7.2.1 allows', () => {
  const CADENCES = [1 * SECOND, 5 * SECOND, 10 * SECOND, 30 * SECOND, 60 * SECOND];

  it.each(CADENCES)('fires on stillness plus an elevated pulse at %ims', (cadenceMs) => {
    const result = assess(fatigueSeries({ cadenceMs, hr: 100 }));
    expect(result.firedRules).toEqual(['fatigue.inactiveElevatedHr']);
    expect(result.level).toBe('amber');
    expect(result.dataQuality).toBe('ok');
  });

  it.each(CADENCES)('stays green when the same stillness carries a settled pulse, at %ims', (
    cadenceMs,
  ) => {
    // The negative half of the grid. Without it, a rule that fired on stillness alone —
    // which is to say on most of a working day — would pass every assertion above.
    const result = assess(fatigueSeries({ cadenceMs, hr: 72 }));
    expect(result.firedRules).toEqual([]);
    expect(result.score).toBe(0);
  });

  it('fires at the slowest cadence with a full interval of freshness lag', () => {
    // The exact case `config.ts` sizes `windowMs` for, and the one that has broken this
    // engine before: a 60 s poll whose newest reading is already 60 s old loses a sample off
    // each end of a half-open window. The observed stillness span is pinned to a number of
    // minutes rather than just "fires", so a regression that leaves it barely satisfied
    // shows up as a changed number instead of staying invisible until the next edit.
    const result = assess(fatigueSeries({ cadenceMs: 60 * SECOND, lagMs: 60 * SECOND, hr: 100 }));
    expect(result.firedRules).toEqual(['fatigue.inactiveElevatedHr']);
    expect(result.metric).toBe('HR 100 bpm, still 16 min');
    expect(result.dataQuality).toBe('ok');
  });

  it('accepts exactly `inactiveForMs` of stillness, and rejects one poll less', () => {
    // `>=`, not `>`, in the rule — because at the slowest cadence the achievable trailing
    // span lands on the threshold rather than past it, and strict `>` would make the rule
    // unsatisfiable there. This pair is what holds that decision in place.
    const cadenceMs = 60 * SECOND;
    const exact = assess(
      fatigueSeries({ cadenceMs, hr: 100, stillForMs: fatigue.inactiveForMs + 1 }),
    );
    expect(exact.metric).toBe(`HR 100 bpm, still ${fatigue.inactiveForMs / MINUTE} min`);
    expect(exact.firedRules).toEqual(['fatigue.inactiveElevatedHr']);

    const short = assess(fatigueSeries({ cadenceMs, hr: 100, stillForMs: fatigue.inactiveForMs }));
    expect(short.firedRules).toEqual([]);
  });

  it('needs the elevated pulse to outlast `sustainedForMs`, not merely to appear', () => {
    const cadenceMs = 60 * SECOND;
    // `trailingRun` measures from the oldest *armed* sample, so it under-reads the true
    // duration by up to one interval: at 60 s a twelve-minute requirement needs thirteen
    // readings. An elevation of exactly `sustainedForMs` therefore must not fire.
    const brief = assess(
      fatigueSeries({ cadenceMs, hr: 100, restingHr: 72, elevatedMs: fatigue.sustainedForMs }),
    );
    expect(brief.firedRules).toEqual([]);

    const long = assess(
      fatigueSeries({
        cadenceMs,
        hr: 100,
        restingHr: 72,
        elevatedMs: fatigue.sustainedForMs + 2 * cadenceMs,
      }),
    );
    expect(long.firedRules).toEqual(['fatigue.inactiveElevatedHr']);
  });
});

describe('neither half of the conjunction fires on its own', () => {
  const cadenceMs = 60 * SECOND;

  it('reports stillness with a settled pulse as exactly that', () => {
    const result = assess(fatigueSeries({ cadenceMs, hr: 72 }));
    expect(result.level).toBe('green');
    expect(result.guidance).toBe('You have been still for a while and your heart rate is settled.');
    expect(result.metric).toMatch(/^HR 72 bpm, still \d+ min$/);
  });

  it('ignores an elevated pulse while the user is moving', () => {
    // 110 bpm on a brisk walk. Reporting fatigue here would put a permanent amber tint on
    // every commute, which is the failure mode that makes users stop reading the cards.
    const result = assess(fatigueSeries({ cadenceMs, hr: 110, stillForMs: 0 }));
    expect(result.firedRules).toEqual([]);
    expect(result.score).toBe(0);
    expect(result.metric).toBe('HR 110 bpm, active');
    expect(result.guidance).toBe('No signs of fatigue.');
  });

  it('would report that same walk as fatigue if the stillness requirement were dropped', () => {
    // The coupling, asserted in the direction that actually protects it. `inactiveForMs: 0`
    // is what a well-meaning "this rule never fires, let's relax it" edit looks like, and it
    // turns the rule into a 90 bpm heart-rate monitor.
    const result = assess(fatigueSeries({ cadenceMs, hr: 110, stillForMs: 0 }), {
      fatigue: { inactiveForMs: 0 },
    });
    expect(result.firedRules).toEqual(['fatigue.inactiveElevatedHr']);
  });
});

describe('boundaries', () => {
  const cadenceMs = 60 * SECOND;

  it('treats `restingHrAbove` as strict, so the threshold itself does not arm the run', () => {
    expect(assess(fatigueSeries({ cadenceMs, hr: fatigue.restingHrAbove })).firedRules).toEqual([]);
    expect(
      assess(fatigueSeries({ cadenceMs, hr: fatigue.restingHrAbove + 1 })).firedRules,
    ).toEqual(['fatigue.inactiveElevatedHr']);
  });

  it('holds the run through readings that straddle the arm threshold', () => {
    // The reason the run is latched rather than consecutive, with the numbers that motivate
    // it: consumer optical HR carries ~7 bpm of resting error, so a true 90 bpm emits
    // readings on both sides of the threshold. Only the readings above it count toward
    // `minSustainedSamples`, so the evidence bar is unchanged by the tolerance.
    const straddling = fatigueSeries({ cadenceMs, hr: 95 }).map((sample, index, all) => ({
      ...sample,
      hr: (all.length - 1 - index) % 2 === 0 ? 95 : 85,
    }));

    expect(assess(straddling).firedRules).toEqual(['fatigue.inactiveElevatedHr']);

    // And the same readings with the deadband removed — `resolveRiskThresholds` clamps the
    // release threshold to the arm threshold, which is exactly the strict behaviour. One
    // noisy sample on the newest reading then erases a quarter of an hour of evidence.
    expect(
      assess(straddling, { fatigue: { restingHrReleaseAbove: fatigue.restingHrAbove } })
        .firedRules,
    ).toEqual([]);
  });

  it('scores from the episode’s peak, not from the newest reading', () => {
    // Under hysteresis the newest sample can sit below the arm threshold while the run still
    // qualifies. Scoring the newest value would then produce a green card beside a fired
    // rule — a self-contradicting card, which is the worst output shape available.
    const dipping = fatigueSeries({ cadenceMs, hr: 110 }).map((sample, index, all) =>
      index === all.length - 1 ? { ...sample, hr: 85 } : sample,
    );
    const result = assess(dipping);
    expect(result.firedRules).toEqual(['fatigue.inactiveElevatedHr']);
    expect(result.level).toBe('amber');
    expect(result.metric).toBe('HR 85 bpm, still 17 min');
  });
});

describe('the advisory is capped at amber and cannot become a flag or an SOS', () => {
  const extreme = assessRisk({
    readings: fatigueSeries({ cadenceMs: 60 * SECOND, hr: 200 }),
    environment: COMFORTABLE,
    now: at(0),
  });

  it('stays inside the amber band at a heart rate no ramp could justify', () => {
    expect(extreme.byCategory.fatigue.score).toBeLessThanOrEqual(69);
    expect(extreme.byCategory.fatigue.level).toBe('amber');
  });

  it('leaves the Dashboard headline to the categories that are allowed to set it', () => {
    // The same window, read by the rule that *is* mandated to flag it. This is the division
    // of labour made visible: 200 bpm is a PRD §7.2.2 tachycardia flag, and fatigue's
    // contribution to that window is one caution card and nothing else.
    expect(extreme.byCategory.cardiovascular.flagged).toBe(true);
    expect(extreme.byCategory.fatigue.flagged).toBe(false);
    expect(extreme.flaggedRules).not.toContain('fatigue.inactiveElevatedHr');
  });

  it('contributes nothing to the SOS trigger set', () => {
    expect(extreme.byCategory.fatigue.criticalRules).toEqual([]);
    expect(extreme.byCategory.fatigue.critical).toBe(false);
    expect(extreme.criticalRules).not.toContain('fatigue.inactiveElevatedHr');
  });

  it('applies no environmental multiplier, because it reads no environment', () => {
    expect(extreme.byCategory.fatigue.envMultiplier).toBe(1);
  });
});

describe('what the card says when the evidence is thin', () => {
  const cadenceMs = 60 * SECOND;

  it('reports `partial` when there is no motion channel to judge stillness with', () => {
    // Motion is not optional here the way it is for the cardiovascular flag: without it the
    // conjunction is unanswerable rather than merely less certain, so the card is silent and
    // says why instead of reading as a confident all-clear.
    const noMotion = fatigueSeries({ cadenceMs, hr: 100 }).map((sample) =>
      reading({ at: sample.timestamp, hr: 100 }),
    );
    const result = assess(noMotion);
    expect(result.firedRules).toEqual([]);
    expect(result.dataQuality).toBe('partial');
    expect(result.metric).toBe('HR 100 bpm, active');
  });

  it('reports `stale` when the newest reading has aged out', () => {
    const result = assess(
      fatigueSeries({ cadenceMs, hr: 100, lagMs: window.maxStaleMs + cadenceMs }),
    );
    expect(result.dataQuality).toBe('stale');
    expect(result.guidance).toBe(
      'Heart-rate reading is out of date, so fatigue cannot be estimated.',
    );
  });

  it('declines to judge when there is no heart rate at all', () => {
    const motionOnly = fatigueSeries({ cadenceMs, hr: 100 }).map((sample) =>
      reading({ at: sample.timestamp, motionSummary: stillMotion() }),
    );
    const result = assess(motionOnly);
    expect(result.dataQuality).toBe('missing');
    expect(result.metric).toBe('Activity —');
    expect(result.guidance).toBe('No recent heart-rate reading.');
  });
});

describe('the fatigue window cannot be configured into an unsatisfiable state', () => {
  /** The floor the window has to clear: it must hold whichever span is longer, plus one
   *  `maxGapMs` of headroom for the half-open boundary and the freshness lag. */
  const floorFor = (inactiveForMs: number, sustainedForMs: number, maxGapMs: number) =>
    Math.max(inactiveForMs, sustainedForMs) + maxGapMs;

  it('ships a default that already satisfies its own floor', () => {
    // `resolveRiskThresholds` returns the defaults untouched when there are no overrides, so
    // the shipped values have to be self-consistent rather than rely on being repaired.
    expect(fatigue.windowMs).toBeGreaterThanOrEqual(
      floorFor(fatigue.inactiveForMs, fatigue.sustainedForMs, window.maxGapMs),
    );
    expect(fatigue.restingHrReleaseAbove).toBeLessThanOrEqual(fatigue.restingHrAbove);
  });

  it('keeps stillness as the binding half of the conjunction', () => {
    // A documented design property, not an accident: `sustainedForMs` is shorter so a pulse
    // that rose partway through a long still stretch still qualifies, which is the shape
    // genuine fatigue has. Reversing the two would silently require the elevation to
    // predate the stillness.
    expect(fatigue.sustainedForMs).toBeLessThan(fatigue.inactiveForMs);
  });

  it('keeps every sample-count floor reachable at the widest tolerated gap', () => {
    // A cadence-versus-count trap the engine does **not** repair, so it is asserted for all
    // three duration rules at once. `maxGapMs` breaks a run, so the most samples a span can
    // hold is `span / maxGapMs + 1`; a count above that is unsatisfiable at the slowest poll
    // the engine tolerates — silently, in the family this file exists to guard against.
    const reachableCount = (spanMs: number) => Math.floor(spanMs / window.maxGapMs) + 1;
    expect(fatigue.minSustainedSamples).toBeLessThanOrEqual(
      reachableCount(fatigue.sustainedForMs),
    );
    expect(heartRate.minSustainedSamples).toBeLessThanOrEqual(
      reachableCount(heartRate.sustainedForMs),
    );
    expect(dehydration.minSustainedSamples).toBeLessThanOrEqual(
      reachableCount(dehydration.sustainedForMs),
    );
  });

  it('widens a window narrower than the stillness it demands', () => {
    const resolved = resolveRiskThresholds({ fatigue: { windowMs: MINUTE } });
    expect(resolved.fatigue.windowMs).toBe(
      floorFor(fatigue.inactiveForMs, fatigue.sustainedForMs, window.maxGapMs),
    );
  });

  it('scales the floor with the configured inactivity span', () => {
    const resolved = resolveRiskThresholds({
      fatigue: { inactiveForMs: 40 * MINUTE, windowMs: MINUTE },
    });
    expect(resolved.fatigue.windowMs).toBe(
      floorFor(40 * MINUTE, fatigue.sustainedForMs, window.maxGapMs),
    );
  });

  it('scales the floor with the elevation span when that is the longer of the two', () => {
    // Both halves have to fit, so the floor tracks the maximum rather than one named field.
    const resolved = resolveRiskThresholds({
      fatigue: { sustainedForMs: 40 * MINUTE, windowMs: MINUTE },
    });
    expect(resolved.fatigue.windowMs).toBe(
      floorFor(fatigue.inactiveForMs, 40 * MINUTE, window.maxGapMs),
    );
  });

  it('clamps a release threshold above its arm threshold', () => {
    // Same trap as `tachycardiaReleaseAbove`: a reading that arms the run could not hold it,
    // which silently raises the effective threshold above the configured one.
    const resolved = resolveRiskThresholds({ fatigue: { restingHrReleaseAbove: 200 } });
    expect(resolved.fatigue.restingHrReleaseAbove).toBe(fatigue.restingHrAbove);
  });

  it('leaves a window that is already wide enough alone', () => {
    const generous = 60 * MINUTE;
    expect(resolveRiskThresholds({ fatigue: { windowMs: generous } }).fatigue.windowMs).toBe(
      generous,
    );
  });

  it('repairs rather than throws, so a bad override degrades instead of crashing', () => {
    // `assessRisk` runs on every sensor tick; a throw here would take the monitoring down,
    // which is the one genuinely unacceptable response from a safety component.
    expect(() =>
      resolveRiskThresholds({
        fatigue: {
          windowMs: 0,
          inactiveForMs: -1,
          restingHrAbove: 0,
          restingHrReleaseAbove: 500,
        },
      }),
    ).not.toThrow();
  });

  it('still fires after a hostile override has been repaired', () => {
    // Repair is only worth anything if the repaired configuration works. The fixture is built
    // against the *widened* window, which is the buffer a real caller would then be feeding.
    const override = { fatigue: { windowMs: SECOND } };
    const resolved = resolveRiskThresholds(override);
    const result = assess(
      fatigueSeries({ cadenceMs: 60 * SECOND, hr: 100, spanMs: resolved.fatigue.windowMs }),
      override,
    );
    expect(result.firedRules).toEqual(['fatigue.inactiveElevatedHr']);
  });
});
