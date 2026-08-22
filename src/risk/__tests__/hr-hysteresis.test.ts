/**
 * Tachycardia vs. *sensor noise*.
 *
 * Same failure shape as `fall-sampling.test.ts`, and found the same way: the suite was
 * green while the rule could not do its job on real input. "HR > 120 sustained" was read
 * as *strictly consecutive readings above 120*, but consumer optical heart-rate carries a
 * resting mean absolute error near 7 bpm, so a true 125 emits readings on both sides of
 * the threshold and almost no real episode satisfies that.
 *
 * The measured worst case, before the fix — five minutes above 120 with a single noisy
 * 119 on the newest reading:
 *
 *     [125, 126, 127, 128, 129, 119]  →  rule: null, level: 'green'
 *
 * Not even the amber advisory: `trailingRun` returned `null` because the newest sample
 * failed the predicate, and `elevated` was newest-only too, so the whole rule fell silent.
 * A green card on sustained tachycardia is the most dangerous output this engine can
 * produce, and one routine sensor artifact was enough to cause it.
 *
 * So the run is now a latch: it arms above 120 and holds above `tachycardiaReleaseAbove`.
 * That buys noise tolerance and immediately raises the opposite risk — a latch that holds
 * through normal readings would over-warn — so both directions are asserted here, and the
 * spec's 120 is pinned as a literal in both.
 */

import { assessRisk } from '../assess';
import { DEFAULT_RISK_THRESHOLDS, resolveRiskThresholds } from '../config';
import type { EnvironmentSnapshot, PartialRiskThresholds, SensorReading, TimedValue } from '../types';
import { trailingRun } from '../window';
import { at, MINUTE, reading, stillMotion } from './fixtures';

const { heartRate, window } = DEFAULT_RISK_THRESHOLDS;
const COMFORTABLE: EnvironmentSnapshot = { tempC: 24, humidity: 50 };
const RELEASE = heartRate.tachycardiaReleaseAbove;

/**
 * One heart-rate reading per minute, newest last, ending at `at(0)`.
 *
 * Still motion throughout, so "at rest" is confirmed and the only variable under test is
 * the heart-rate sequence itself.
 */
function hrSeries(values: readonly number[]): SensorReading[] {
  const last = values.length - 1;
  return values.map((hr, index) =>
    reading({ at: at(-(last - index) * MINUTE), hr, spo2: 98, motionSummary: stillMotion() }),
  );
}

function cardio(values: readonly number[], thresholds?: PartialRiskThresholds) {
  return assessRisk({ readings: hrSeries(values), environment: COMFORTABLE, thresholds })
    .byCategory.cardiovascular;
}

/** Six readings a minute apart span exactly `sustainedForMs` (5 min) by default. */
const SUSTAINED_COUNT = heartRate.sustainedForMs / MINUTE + 1;

/** `n` readings of the same value, spanning at least `sustainedForMs`. */
const flat = (value: number, count = SUSTAINED_COUNT) => Array<number>(count).fill(value);

describe('sensor noise cannot erase a sustained episode', () => {
  it('flags a genuine episode whose newest reading is a noise dip', () => {
    // The regression. This exact input previously returned rule `null` / level `green`.
    const result = cardio([125, 126, 127, 128, 129, 119]);
    expect(result.flagged).toBe(true);
    expect(result.rule).toBe('cardiovascular.hr.tachycardia');
    expect(result.level).toBe('red');
  });

  it('flags a run that straddles the threshold from end to end', () => {
    // Eight minutes of a true HR near 127 as a ±7 bpm sensor would actually report it.
    // Its longest strictly-consecutive run above 120 is two samples, spanning one minute.
    const result = cardio([129, 131, 118, 127, 133, 122, 119, 128]);
    expect(result.flagged).toBe(true);
    expect(result.rule).toBe('cardiovascular.hr.tachycardia');
  });

  it('flags across a dip in the middle of the run', () => {
    expect(cardio([125, 126, 119, 128, 129, 130]).flagged).toBe(true);
  });

  it('still flags a clean run with no dips at all', () => {
    // Control: if this ever fails, the failures above mean something other than what
    // they claim.
    expect(cardio(flat(125)).flagged).toBe(true);
  });
});

describe('the latch releases', () => {
  it('reports no cardiovascular risk once HR falls below the release floor', () => {
    const result = cardio([125, 126, 127, 128, 129, RELEASE - 5]);
    expect(result.flagged).toBe(false);
    expect(result.rule).toBeNull();
    expect(result.level).toBe('green');
  });

  it('treats the release floor itself as released — strict `>`', () => {
    expect(cardio([125, 126, 127, 128, 129, RELEASE]).rule).toBeNull();
  });

  it('still holds one bpm above the release floor', () => {
    expect(cardio([125, 126, 127, 128, 129, RELEASE + 1]).flagged).toBe(true);
  });
});

describe('the specified threshold of 120 is not lowered by the latch', () => {
  it('does not flag at exactly 120, however long it is held', () => {
    // Load-bearing under the new mechanism, not merely a restatement of the spec test:
    // 120 *sustains* the latch (it is above the release floor) and must still never arm
    // it. If arming ever slips to `>=`, this is the test that catches it.
    const result = cardio(flat(120));
    expect(result.flagged).toBe(false);
    expect(result.firedRules).toEqual([]);
    expect(result.level).toBe('green');
  });

  it('does not flag when readings only ever sit inside the deadband', () => {
    // Every reading holds the latch and none arms it, so there is no episode to report.
    const inBand = Math.round((RELEASE + 120) / 2);
    expect(inBand).toBeGreaterThan(RELEASE);
    expect(inBand).toBeLessThan(120);

    const result = cardio(flat(inBand, 10));
    expect(result.flagged).toBe(false);
    expect(result.rule).toBeNull();
  });

  it('needs three readings above 120, not one spike and a quiet stretch', () => {
    // The abuse case the latch creates: one 121, then six minutes inside the deadband.
    // The *span* clears `sustainedForMs`, so `minSustainedSamples` is the only thing
    // standing between this and a red card — which is why it counts armed readings only.
    const result = cardio([121, ...flat(RELEASE + 5, 6)]);
    expect(result.flagged).toBe(false);
    expect(result.firedRules).toEqual(['cardiovascular.hr.tachycardia.unconfirmed']);
    expect(result.level).toBe('amber');
  });

  it('measures the span from the first reading above 120, not from the start of the latch', () => {
    // Six minutes in the deadband, then three minutes above 120. The armed span is
    // 2 min — short of `sustainedForMs` — while the latch reaches back 8 min. Measuring
    // from the latch boundary would report a brief spike as a sustained episode.
    const result = cardio([...flat(RELEASE + 5, 6), 121, 122, 123]);
    expect(result.flagged).toBe(false);
    expect(result.firedRules).toEqual(['cardiovascular.hr.tachycardia.unconfirmed']);
  });
});

describe('the reported level and metric describe the episode, not the last sample', () => {
  it('scores from the episode peak rather than the newest reading', () => {
    // Scoring 119 takes `scoreFor`'s normal-band branch and lands near 39 — a green card
    // carrying `flagged: true`, which is a self-contradicting output.
    const result = cardio([125, 126, 127, 128, 129, 119]);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.level).toBe('red');
  });

  it('names the peak when the current reading is lower than it', () => {
    expect(cardio([125, 126, 127, 128, 129, 119]).metric).toBe('HR 119 bpm (peak 129)');
  });

  it('leaves the metric alone when the newest reading is the peak', () => {
    expect(cardio(flat(121)).metric).toBe('HR 121 bpm');
  });
});

describe('a release floor above the arm threshold is repaired, not obeyed', () => {
  const resolveRelease = (value: number) =>
    resolveRiskThresholds({ heartRate: { tachycardiaReleaseAbove: value } }).heartRate
      .tachycardiaReleaseAbove;

  it('clamps the release floor down to the arm threshold', () => {
    // Left alone, a release floor of 130 means a reading of 125 arms the run but cannot
    // hold it, so nothing under 131 ever flags — the spec's 120 silently becomes 130.
    expect(resolveRelease(130)).toBe(120);
  });

  it('keeps 121 flagging under that override', () => {
    expect(cardio(flat(121), { heartRate: { tachycardiaReleaseAbove: 130 } }).flagged).toBe(true);
  });

  it('leaves a release floor below the arm threshold untouched', () => {
    expect(resolveRelease(105)).toBe(105);
  });

  it('defaults to a self-consistent pair, since overrides are skipped entirely', () => {
    // `resolveRiskThresholds` returns the defaults by reference when called with no
    // overrides, so the defaults have to satisfy their own invariant.
    expect(heartRate.tachycardiaReleaseAbove).toBeLessThanOrEqual(heartRate.tachycardiaAbove);
  });
});

describe('trailingRun without a release predicate is strictly consecutive', () => {
  const timed = (values: readonly number[]): TimedValue[] => {
    const last = values.length - 1;
    return values.map((value, index) => ({ value, timestamp: at(-(last - index) * MINUTE) }));
  };
  const above120 = (value: number) => value > 120;

  it('breaks the run on any non-qualifying sample', () => {
    // Back-compat for the three-argument form: `sustains` defaults to `qualifies`, so
    // every sample in the run is armed and the old semantics hold exactly.
    const run = trailingRun(timed([121, 122, 119, 123]), above120, window.maxGapMs);
    expect(run?.count).toBe(1);
    expect(run?.spanMs).toBe(0);
  });

  it('returns null when the newest sample does not qualify', () => {
    expect(trailingRun(timed([121, 122, 119]), above120, window.maxGapMs)).toBeNull();
  });

  it('counts only armed samples and reports their peak', () => {
    const run = trailingRun(
      timed([121, 115, 133, 116, 128]),
      above120,
      window.maxGapMs,
      (value) => value > RELEASE,
    );
    expect(run?.count).toBe(3);
    expect(run?.maxValue).toBe(133);
    // From the oldest armed sample (the 121, four minutes back) to the newest.
    expect(run?.spanMs).toBe(4 * MINUTE);
    expect(run?.reachesStart).toBe(true);
  });

  it('returns null when nothing ever armed the latch', () => {
    const run = trailingRun(
      timed([115, 116, 118]),
      above120,
      window.maxGapMs,
      (value) => value > RELEASE,
    );
    expect(run).toBeNull();
  });

  it('breaks the latch on a coverage gap wider than maxGapMs', () => {
    // Unobserved time is not qualifying time — the latch must not bridge a gap either.
    const samples: TimedValue[] = [
      { value: 130, timestamp: at(-(window.maxGapMs + MINUTE)) },
      { value: 121, timestamp: at(0) },
    ];
    const run = trailingRun(samples, above120, window.maxGapMs, (value) => value > RELEASE);
    expect(run?.count).toBe(1);
    expect(run?.maxValue).toBe(121);
  });
});
