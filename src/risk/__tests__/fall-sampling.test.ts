/**
 * Fall rule vs. the *sampling rate*.
 *
 * These exist because the whole 111-test suite passed while the fall flag could not fire
 * at all on real hardware. Every fall test sampled at 1 Hz; PRD §7.2.1 polls every
 * 30–60 s. Stillness is measured as the *span* between still readings, so a 30 s
 * post-impact search window held one reading at best and none at worst — a span of
 * 0 ms — and `fall.impactThenStillness` was mathematically unsatisfiable, silently.
 *
 * Two distinct guards, and they had to land together:
 *  - the window must be wide enough for the sampler to place two readings in it, and
 *  - the impact must require a free-fall dip, because widening the window is exactly
 *    what makes "walked across the room, then sat down" reachable.
 *
 * Disabling either one alone is a shipped defect, so both directions are asserted.
 */

import { assessRisk } from '../assess';
import { DEFAULT_RISK_THRESHOLDS, resolveRiskThresholds } from '../config';
import type {
  EnvironmentSnapshot,
  MotionSummary,
  PartialRiskThresholds,
  SensorReading,
} from '../types';
import { activeMotion, at, impactMotion, MINUTE, reading, SECOND, stillMotion } from './fixtures';

const { fall, window } = DEFAULT_RISK_THRESHOLDS;
const COMFORTABLE: EnvironmentSnapshot = { tempC: 24, humidity: 50 };

/**
 * One motion interval, then nothing but stillness, sampled every `cadenceMs`.
 * The default five-minute span is long enough that no cadence under test runs out of
 * room — a shorter span would confound "cannot detect" with "not enough history".
 */
function motionThenStillness(
  first: MotionSummary,
  cadenceMs: number,
  spanMs = 5 * MINUTE,
): SensorReading[] {
  const startAt = at(-spanMs);
  const readings: SensorReading[] = [
    reading({ at: startAt, hr: 88, spo2: 97, motionSummary: first }),
  ];
  for (let t = startAt + cadenceMs; t <= at(0); t += cadenceMs) {
    readings.push(reading({ at: t, hr: 88, spo2: 97, motionSummary: stillMotion() }));
  }
  return readings;
}

function assess(readings: readonly SensorReading[], thresholds?: PartialRiskThresholds) {
  return assessRisk({ readings, environment: COMFORTABLE, thresholds });
}

describe('fall detection survives every polling cadence PRD §7.2.1 allows', () => {
  // 30 s and 60 s are the spec'd range; 1–10 s are the rates the suite used to test
  // exclusively, kept so a regression shows up as a *narrowing* rather than a flip.
  const CADENCES = [1 * SECOND, 5 * SECOND, 10 * SECOND, 30 * SECOND, 60 * SECOND];

  it.each(CADENCES)('confirms a genuine fall when sampled every %ims', (cadenceMs) => {
    const result = assess(motionThenStillness(impactMotion(3), cadenceMs));
    expect(result.flaggedRules).toContain('fall.impactThenStillness');
    expect(result.criticalRules).toContain('fall.impactThenStillness');
    expect(result.sosCandidate).toBe(true);
  });

  it('needs only two readings after the impact, which is what sets the window width', () => {
    // The mechanism, stated directly: one still reading spans 0 ms and proves nothing,
    // two spanning >= stillnessMs prove it. Any window narrower than the poll interval
    // therefore cannot work no matter how the thresholds are tuned.
    const impactAt = at(-MINUTE);
    const one = [
      reading({ at: impactAt, motionSummary: impactMotion(3) }),
      reading({ at: at(0), motionSummary: stillMotion() }),
    ];
    expect(assess(one).flaggedRules).not.toContain('fall.impactThenStillness');

    const two = [
      reading({ at: impactAt, motionSummary: impactMotion(3) }),
      reading({ at: at(-fall.stillnessMs), motionSummary: stillMotion() }),
      reading({ at: at(0), motionSummary: stillMotion() }),
    ];
    expect(assess(two).flaggedRules).toContain('fall.impactThenStillness');
  });
});

describe('the post-impact window cannot be configured into an unsatisfiable state', () => {
  it('ships a default that already satisfies its own floor', () => {
    // `resolveRiskThresholds` returns the defaults untouched when there are no
    // overrides, so the default must be self-consistent rather than rely on repair.
    expect(fall.stillnessWindowMs).toBeGreaterThanOrEqual(fall.stillnessMs + window.maxGapMs);
  });

  it('raises a window too narrow to hold two readings', () => {
    // 30 s was the shipped value and the actual bug.
    const resolved = resolveRiskThresholds({ fall: { stillnessWindowMs: 30 * SECOND } });
    expect(resolved.fall.stillnessWindowMs).toBe(fall.stillnessMs + window.maxGapMs);
  });

  it('scales the floor with whatever stillness duration is configured', () => {
    const resolved = resolveRiskThresholds({
      fall: { stillnessMs: 45 * SECOND, stillnessWindowMs: SECOND },
    });
    expect(resolved.fall.stillnessWindowMs).toBe(45 * SECOND + window.maxGapMs);
  });

  it('leaves a window that is already wide enough alone', () => {
    const generous = 20 * MINUTE;
    expect(resolveRiskThresholds({ fall: { stillnessWindowMs: generous } }).fall.stillnessWindowMs)
      .toBe(generous);
  });

  it('repairs rather than throws, so a bad override degrades instead of crashing', () => {
    expect(() => resolveRiskThresholds({ fall: { stillnessWindowMs: 0 } })).not.toThrow();
  });
});

describe('the impact stage requires free-fall, not just a spike', () => {
  // `activeMotion(peakG)` is a walking pocket phone: footstrike peak, minG 0.7, rms
  // pinned near 1 g. `impactMotion(peakG)` is a fall: same peak band, minG 0.05.
  // The peak alone cannot separate them, which is the entire point.
  it('ignores a walk-then-sit even though its peak reaches the impact threshold', () => {
    const result = assess(motionThenStillness(activeMotion(fall.impactG), 60 * SECOND));
    expect(result.flaggedRules).not.toContain('fall.impactThenStillness');
    expect(result.firedRules).not.toContain('fall.impact.unconfirmed');
    expect(result.byCategory.fall.level).toBe('green');
    expect(result.sosCandidate).toBe(false);
  });

  it('confirms the same peak when the interval also dipped into free-fall', () => {
    const result = assess(motionThenStillness(impactMotion(fall.impactG), 60 * SECOND));
    expect(result.flaggedRules).toContain('fall.impactThenStillness');
  });

  it('would confirm the walk as a fall if the free-fall gate were removed', () => {
    // The coupling, asserted so it cannot be undone piecemeal: widening the window
    // without gating the impact turns an everyday action into an SOS candidate. If
    // someone loosens `freeFallMaxG` back toward the motion ceiling, this test says why.
    const result = assess(motionThenStillness(activeMotion(fall.impactG), 60 * SECOND), {
      fall: { freeFallMaxG: 32 },
    });
    expect(result.flaggedRules).toContain('fall.impactThenStillness');
    expect(result.sosCandidate).toBe(true);
  });

  it('treats the free-fall ceiling as inclusive, and one step above it as not free-fall', () => {
    const dip = (minG: number): MotionSummary => ({
      peakG: 3,
      minG,
      rmsG: 1.02,
      sampleCount: 50,
    });
    expect(
      assess(motionThenStillness(dip(fall.freeFallMaxG), 60 * SECOND)).flaggedRules,
    ).toContain('fall.impactThenStillness');
    expect(
      assess(motionThenStillness(dip(fall.freeFallMaxG + 0.01), 60 * SECOND)).flaggedRules,
    ).not.toContain('fall.impactThenStillness');
  });

  it('still applies the peak threshold — a free-fall dip alone is not an impact', () => {
    const driftNoSpike: MotionSummary = { peakG: 1.2, minG: 0.1, rmsG: 1, sampleCount: 50 };
    expect(
      assess(motionThenStillness(driftNoSpike, 60 * SECOND)).flaggedRules,
    ).not.toContain('fall.impactThenStillness');
  });
});

describe('an unresolved impact never reports an all-clear', () => {
  /** Quiet history, an impact `agoMs` back, then stillness — sampled every `cadenceMs`. */
  function impactThenQuiet(cadenceMs: number, agoMs: number): SensorReading[] {
    const readings: SensorReading[] = [];
    for (let t = at(-5 * MINUTE); t < at(-agoMs); t += cadenceMs) {
      readings.push(reading({ at: t, hr: 80, spo2: 98, motionSummary: stillMotion() }));
    }
    readings.push(reading({ at: at(-agoMs), hr: 80, spo2: 98, motionSummary: impactMotion(3) }));
    for (let t = at(-agoMs) + cadenceMs; t <= at(0); t += cadenceMs) {
      readings.push(reading({ at: t, hr: 80, spo2: 98, motionSummary: stillMotion() }));
    }
    return readings;
  }

  it.each([1 * SECOND, 30 * SECOND, 60 * SECOND])(
    'says "checking" rather than "moving normally" one tick after an impact, at %ims',
    (cadenceMs) => {
      // The regression: the grace period used to be `stillnessMs` (10 s), which expires
      // before the first post-impact reading arrives at a 30–60 s cadence. A genuine
      // fall therefore got `dataQuality: 'ok'` and "you appear to be moving normally"
      // on the tick after it happened — a confident all-clear on a real fall. Only 1 Hz
      // sampling, which is all the rest of the suite used, behaved correctly.
      const fallCategory = assess(impactThenQuiet(cadenceMs, cadenceMs)).byCategory.fall;
      expect(fallCategory.rule).toBe('fall.impact.unconfirmed');
      expect(fallCategory.dataQuality).toBe('partial');
      expect(fallCategory.guidance).toContain('checking whether you are moving');
    },
  );

  it('stays pending for as long as the search window is still open', () => {
    const justInside = assess(impactThenQuiet(60 * SECOND, fall.stillnessWindowMs - MINUTE));
    expect(justInside.byCategory.fall.dataQuality).toBe('partial');
  });

  it('does report normal movement once the whole window has been searched', () => {
    // The other direction: `unconfirmed` must stay reachable, or every knock would sit
    // in "checking" forever. Past the window with no stillness, "moving normally" is
    // the honest answer — so a phone knock does not linger as a possible fall.
    const readings: SensorReading[] = [
      reading({ at: at(-8 * MINUTE), motionSummary: impactMotion(3) }),
      ...[6, 4, 2, 0].map((n) =>
        reading({ at: at(-n * MINUTE), motionSummary: activeMotion(1.8) }),
      ),
    ];
    const fallCategory = assess(readings).byCategory.fall;
    expect(fallCategory.rule).toBe('fall.impact.unconfirmed');
    expect(fallCategory.dataQuality).toBe('ok');
    expect(fallCategory.guidance).toContain('moving normally');
    expect(fallCategory.flagged).toBe(false);
  });
});

describe('an unknown interval minimum fails open rather than disabling the rule', () => {
  it('accepts a lone raw vector, which carries no interval minimum at all', () => {
    // A single sample's minimum is itself, so gating on it would reject every
    // raw-vector impact and silently switch fall detection off for that input shape.
    // A missed fall is the worse error and PRD §7.2.5's 30 s cancel absorbs a false one.
    const impactAt = at(-MINUTE);
    const readings = [
      reading({ at: impactAt, motion: { x: 0, y: 0, z: 3 } }),
      reading({ at: at(-fall.stillnessMs), motionSummary: stillMotion() }),
      reading({ at: at(0), motionSummary: stillMotion() }),
    ];
    expect(assess(readings).flaggedRules).toContain('fall.impactThenStillness');
  });

  it('accepts a summary whose minimum is unusable but whose peak is fine', () => {
    const badMin: MotionSummary = { peakG: 3, minG: Number.NaN, rmsG: 1.02, sampleCount: 50 };
    expect(assess(motionThenStillness(badMin, 60 * SECOND)).flaggedRules).toContain(
      'fall.impactThenStillness',
    );
  });

  it('accepts a summary whose minimum is outside the plausible range', () => {
    const impossibleMin: MotionSummary = { peakG: 3, minG: -5, rmsG: 1.02, sampleCount: 50 };
    expect(assess(motionThenStillness(impossibleMin, 60 * SECOND)).flaggedRules).toContain(
      'fall.impactThenStillness',
    );
  });
});
