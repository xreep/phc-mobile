/**
 * Pins the demo sensor window and the assessment the Dashboard renders from it.
 *
 * Three jobs. The first is ordinary regression cover: the Home screen's cards are now
 * computed, so the values a reviewer sees on screen are only trustworthy if something
 * asserts what the engine returns for this fixture.
 *
 * The second matters more. A fixture that produces four plausible cards can still be
 * wrong in the way this engine has been wrong four times already — a threshold that is
 * unsatisfiable given the sampling cadence or the window shape, failing silently, with a
 * green card over a real event and a green test suite over the lot. A green `fall` card
 * proves nothing on its own; it has to be shown to be a *reachable* negative. So the
 * escalation this fixture is built to avoid is asserted to fire when the motion that
 * suppresses it is removed, and the freshness margin that keeps it reachable is asserted
 * directly.
 *
 * The third is new with the live environment feed. The weather half of this window is no
 * longer a constant: `buildEnvironmentSnapshot` narrows a real OpenWeatherMap observation.
 * That introduces one more member of the same silent-failure family — an AQI arriving on the
 * provider's 1–5 scale instead of the 0–500 scale the thresholds are written against — so the
 * consequence of getting it wrong is asserted here, at the engine, rather than only at the
 * fetch boundary.
 */

import { VITALS } from '@/constants/health-data';
import {
  buildEnvironmentSnapshot,
  buildMockReadings,
  MOCK_WINDOW,
} from '@/constants/mock-sensor-window';
import { FIXTURE_OBSERVATION_AGE_MS, liveEnvironment } from '@/environment/__tests__/fixtures';
import { assessRisk, DEFAULT_RISK_THRESHOLDS as T } from '@/risk';
import type { SensorReading } from '@/risk';

/** Fixed instant, so every expectation below is exact. Matches the fixture's `FIXTURE_NOW`. */
const NOW = 1_766_000_000_000;

/**
 * The observation the Dashboard would be holding: 38 °C at 62 % RH with an EPA AQI of 168,
 * which are the conditions the retired `ENVIRONMENT` constant described. They are now test
 * input rather than something the app ships, and the fixture *derives* the heat index from
 * them, so the three numbers cannot drift apart.
 */
const LIVE = liveEnvironment();

const readings = buildMockReadings(NOW);
const environment = buildEnvironmentSnapshot(LIVE);
const assessment = assessRisk({ readings, environment, now: NOW });

const newest = readings[readings.length - 1];

describe('mock sensor window', () => {
  it('is a pure function of `now`', () => {
    expect(buildMockReadings(NOW)).toEqual(readings);

    // Shifting the anchor shifts every timestamp by the same amount and changes nothing
    // else — the fixture carries no hidden clock read.
    const shifted = buildMockReadings(NOW + 5_000);
    expect(shifted.map((r) => r.timestamp)).toEqual(readings.map((r) => r.timestamp + 5_000));
    expect(shifted.map((r) => ({ ...r, timestamp: 0 }))).toEqual(
      readings.map((r) => ({ ...r, timestamp: 0 })),
    );
  });

  it('is ordered oldest → newest with no gap the engine would treat as a break', () => {
    for (let i = 1; i < readings.length; i += 1) {
      const gap = readings[i].timestamp - readings[i - 1].timestamp;
      expect(gap).toBe(MOCK_WINDOW.intervalMs);
      expect(gap).toBeLessThanOrEqual(T.window.maxGapMs);
    }
  });

  it('reaches back past the engine’s longest lookback', () => {
    // `assess.ts` clamps to the widest span any rule needs. A window shorter than that
    // leaves the extended-lookback rules quietly reading a truncated buffer rather than
    // erroring — which is why this is asserted here and not left to arithmetic in a comment.
    // The bound is currently set by `fatigue.windowMs`, not by the heat escalation, so a
    // reviewer widening either advisory window will be told by this test that the demo
    // buffer has to grow with it.
    const longestLookbackMs = Math.max(
      T.window.ms,
      T.stillness.heatCriticalMs + T.window.maxGapMs,
      T.fall.stillnessWindowMs,
      T.dehydration.windowMs,
      T.fatigue.windowMs,
    );
    expect(NOW - readings[0].timestamp).toBeGreaterThan(longestLookbackMs);
  });

  it('keeps the newest reading fresh enough for every rule to be reachable', () => {
    expect(NOW - newest.timestamp).toBe(MOCK_WINDOW.latestAgeMs);
    expect(MOCK_WINDOW.latestAgeMs).toBeLessThan(T.window.maxStaleMs);

    // The binding constraint, and the reason this is not simply "under maxStaleMs":
    // the extended lookback's `maxGapMs` headroom has to cover both this lag and the
    // half-open boundary's one-sample epsilon, so at this cadence a lag of a full
    // interval makes PRD §7.2.5's collapse escalation unsatisfiable. See the escalation
    // test below, which is what actually proves it is still reachable.
    expect(MOCK_WINDOW.latestAgeMs).toBeLessThan(MOCK_WINDOW.intervalMs);
  });

  it('ends on the vitals the Dashboard shows', () => {
    expect(newest.hr).toBe(VITALS.hr);
    expect(newest.spo2).toBe(VITALS.spo2);
    expect(newest.skinTempC).toBe(VITALS.skinTempC);
    expect(newest.source).toBe('simulated');
  });

  it('does not vary a vital by so little that a peak-vs-newest mix-up would hide', () => {
    // A constant series makes several distinct rule bugs invisible, because the newest
    // sample and the window's extreme coincide.
    const hrValues = readings.map((r) => r.hr as number);
    expect(Math.max(...hrValues)).toBeGreaterThan(Math.min(...hrValues));
    expect(Math.max(...hrValues)).toBeGreaterThan(newest.hr as number);
  });
});

describe('the live environment the window is paired with', () => {
  it('forwards only the measurements the engine consumes', () => {
    expect(environment).toEqual({
      tempC: LIVE.tempC,
      humidity: LIVE.humidity,
      aqi: LIVE.aqi,
      observedAt: NOW - FIXTURE_OBSERVATION_AGE_MS,
    });
    expect(FIXTURE_OBSERVATION_AGE_MS).toBeLessThan(T.env.maxStaleMs);
  });

  it('narrows nothing when there is no observation yet', () => {
    // The feed is asynchronous, so before the first response there genuinely is no weather,
    // and `null` is the only honest input.
    expect(buildEnvironmentSnapshot(null)).toBeNull();
  });

  it('declines to judge heat rather than reporting comfortable conditions', () => {
    const blind = assessRisk({ readings, environment: null, now: NOW });
    const heat = blind.byCategory.heat;

    // A zero-filled snapshot would instead assert 0 °C at 0 % humidity and render a
    // confident green "comfortable" card built on nothing at all. `level` is green either
    // way — it is the only level available — so `dataQuality` carries the whole difference.
    expect(heat.dataQuality).toBe('missing');
    expect(heat.flagged).toBe(false);
    expect(blind.heatIndexC).toBeNull();
    expect(heat.metric).toBe('Heat index —');
    expect(heat.guidance).not.toMatch(/comfortable|normal range/i);
  });
});

describe('the AQI scale reaching the engine', () => {
  /** The reported respiratory multiplier for a given AQI, all else held equal. */
  function multiplierFor(aqi: number | null) {
    return assessRisk({
      readings,
      environment: buildEnvironmentSnapshot(liveEnvironment({ aqi })),
      now: NOW,
    }).byCategory.respiratory.envMultiplier;
  }

  it('amplifies on the 0–500 scale the thresholds are written against', () => {
    // 168 → (168 − 100) / (300 − 100) × (1.3 − 1) + 1.
    expect(multiplierFor(168)).toBeCloseTo(1.102, 3);
  });

  it('would silently stop amplifying if the provider’s 1–5 band were forwarded raw', () => {
    // This is the failure the EPA computation in `@/environment` exists to prevent, asserted
    // at the place it would actually be felt. OpenWeatherMap reports the same dirty air as
    // `main.aqi: 4`, and `respiratory.ts`'s `aqi <= env.aqiNeutralBelow` is then permanently
    // true — no throw, no log, no failing test, and PRD §7.2.3's environmental amplification
    // simply never happens. Pinning both numbers is what makes the regression loud.
    expect(multiplierFor(4)).toBe(1);
    expect(multiplierFor(4)).toBeLessThan(multiplierFor(168));
  });

  it('does not amplify when air quality is missing, rather than treating it as clean', () => {
    expect(multiplierFor(null)).toBe(1);
  });
});

describe('the assessment the Dashboard renders', () => {
  it('is red overall, driven by heat, and is not an SOS candidate', () => {
    expect(assessment.level).toBe('red');
    expect(assessment.flaggedRules).toEqual(['heat.index.extremeDanger']);
    expect(assessment.criticalRules).toEqual([]);
    expect(assessment.sosCandidate).toBe(false);
  });

  it('evaluated a usable number of samples, so no category is guessing', () => {
    expect(assessment.sampleCount).toBeGreaterThanOrEqual(T.window.minSamples);
    for (const category of assessment.categories) {
      expect(category.dataQuality).toBe('ok');
    }
  });

  it('bands the heat index against NOAA', () => {
    // The engine derives its own heat index from `tempC` and `humidity`; the snapshot
    // deliberately does not carry one. Equality with the observation's is the property that
    // makes the omission safe — `service.test.ts` asserts the same thing end to end.
    expect(assessment.heatIndexC).toBe(LIVE.heatIndexC);
    expect(assessment.heatIndexBand?.label).toBe('Extreme Danger');
    expect(assessment.heatIndexOutOfDomain).toBe(false);
  });

  it('produces the six cards in dashboard order', () => {
    expect(assessment.categories.map((c) => c.key)).toEqual([
      'heat',
      'respiratory',
      'cardiovascular',
      'fall',
      'dehydration',
      'fatigue',
    ]);

    expect(
      assessment.categories.map((c) => ({
        key: c.key,
        level: c.level,
        flagged: c.flagged,
        rule: c.rule,
        metric: c.metric,
        guidance: c.guidance,
      })),
    ).toEqual([
      {
        key: 'heat',
        level: 'red',
        flagged: true,
        rule: 'heat.index.extremeDanger',
        metric: 'Heat index 56°C',
        guidance: 'Extreme heat danger — get indoors or into shade and cool down now.',
      },
      {
        key: 'respiratory',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'SpO₂ 97%',
        guidance: 'Blood oxygen is in the normal range.',
      },
      {
        key: 'cardiovascular',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'HR 78 bpm',
        guidance: 'Resting heart rate looks normal.',
      },
      {
        key: 'fall',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'Active',
        guidance: 'No fall or unusual stillness detected.',
      },
      {
        // Extreme heat *without* cardiovascular drift. This is the pair that shows the
        // dehydration rule is a conjunction and not a second heat card: the heat index here
        // is 56 °C, far past the exposure threshold, and the card is still green because the
        // heart rate has not moved off its own baseline. The escalation block below asserts
        // the reachable positive.
        key: 'dehydration',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'HR +0 bpm vs baseline 78',
        guidance: 'Heat exposure is high but your heart rate is steady — keep drinking water.',
      },
      {
        key: 'fatigue',
        level: 'green',
        flagged: false,
        rule: null,
        metric: 'HR 78 bpm, active',
        guidance: 'No signs of fatigue.',
      },
    ]);
  });

  it('scores heat in the red band and leaves the rest at zero', () => {
    expect(assessment.byCategory.heat.score).toBeGreaterThanOrEqual(90);
    expect(assessment.byCategory.respiratory.score).toBe(0);
    expect(assessment.byCategory.cardiovascular.score).toBe(0);
    expect(assessment.byCategory.fall.score).toBe(0);
    expect(assessment.byCategory.dehydration.score).toBe(0);
    expect(assessment.byCategory.fatigue.score).toBe(0);
  });
});

describe('the escalation this fixture is built to avoid', () => {
  /** The same window with the movement removed — a person who has not stirred. */
  const stillWindow: SensorReading[] = buildMockReadings(NOW).map((reading) => ({
    ...reading,
    motionSummary: MOCK_WINDOW.still,
  }));

  const collapsed = assessRisk({ readings: stillWindow, environment, now: NOW });

  it('fires once the trailing movement is gone, so the green fall card is a real negative', () => {
    expect(collapsed.criticalRules).toContain('heat.stillness.critical');
    expect(collapsed.sosCandidate).toBe(true);
    expect(collapsed.byCategory.heat.critical).toBe(true);
    expect(collapsed.byCategory.heat.guidance).toBe(
      'Extreme heat and no movement detected — this may be heat collapse.',
    );
  });

  it('is suppressed in the shipped fixture only because the user is moving now', () => {
    // Same heat, same environment, same vitals — the trailing motion is the only
    // difference, which is what makes this pair a control rather than two unrelated runs.
    expect(assessment.byCategory.heat.rule).toBe('heat.index.extremeDanger');
    expect(collapsed.byCategory.heat.rule).toBe('heat.stillness.critical');
    expect(assessment.byCategory.heat.metric).toBe(collapsed.byCategory.heat.metric);
  });

  it('still reports no fall, because stillness alone is not a fall', () => {
    // PRD §7.2.2's fall flag needs an impact *then* stillness. Asserting this keeps the
    // control above from being mistaken for fall detection.
    expect(collapsed.byCategory.fall.flagged).toBe(false);
    expect(collapsed.criticalRules).not.toContain('fall.impactThenStillness');
  });

  it('satisfies fatigue’s stillness half without firing it, because the pulse is settled', () => {
    // Half of a conjunction, asserted directly: fifteen minutes of stillness are present
    // here, so the green fatigue card on the demo screen is held green by the heart rate
    // alone. Without this the card could be green because the rule is dead.
    expect(collapsed.byCategory.fatigue.metric).toMatch(/still \d+ min$/);
    expect(collapsed.byCategory.fatigue.rule).toBeNull();
    expect(collapsed.byCategory.fatigue.level).toBe('green');
  });
});

describe('the advisory cards on the demo screen are reachable negatives', () => {
  /** The shipped window, motion removed, with `hr` transformed by `raise`. */
  function variant(raise: (hr: number, timestamp: number) => number): SensorReading[] {
    return buildMockReadings(NOW).map((reading) => ({
      ...reading,
      motionSummary: MOCK_WINDOW.still,
      hr: raise(reading.hr as number, reading.timestamp),
    }));
  }

  /**
   * Someone who stopped moving in extreme heat and whose pulse then climbed 20 bpm — the
   * elevation confined to the newest part of the window, which is what makes it a *drift*
   * away from the window's own baseline rather than a level.
   */
  const drifting = assessRisk({
    readings: variant((hr, timestamp) => (timestamp > NOW - 9 * 60_000 ? hr + 20 : hr)),
    environment,
    now: NOW,
  });

  /**
   * The same 20 bpm, raised across the *whole* window instead. Nothing drifts — the baseline
   * moves with it — but the pulse is now elevated through fifteen unbroken minutes of
   * stillness, which is the fatigue shape.
   */
  const sustained = assessRisk({
    readings: variant((hr) => hr + 20),
    environment,
    now: NOW,
  });

  it('fires dehydration on heat plus drift, and only as an advisory', () => {
    expect(drifting.byCategory.dehydration.firedRules).toContain(
      'dehydration.cardiovascularDrift',
    );
    expect(drifting.byCategory.dehydration.level).not.toBe('green');

    // The containment, asserted where it would actually be felt: this fixture *is* an SOS
    // candidate — `heat.stillness.critical` fires on the same window — so if dehydration
    // could contribute a critical rule it would be adding a second reason to text every
    // emergency contact. It cannot.
    expect(drifting.sosCandidate).toBe(true);
    expect(drifting.byCategory.dehydration.flagged).toBe(false);
    expect(drifting.byCategory.dehydration.criticalRules).toEqual([]);
    expect(drifting.flaggedRules).not.toContain('dehydration.cardiovascularDrift');
    expect(drifting.criticalRules).not.toContain('dehydration.cardiovascularDrift');
  });

  it('fires fatigue on stillness plus an elevated pulse, capped at amber', () => {
    expect(sustained.byCategory.fatigue.firedRules).toEqual(['fatigue.inactiveElevatedHr']);
    expect(sustained.byCategory.fatigue.level).toBe('amber');
    expect(sustained.byCategory.fatigue.flagged).toBe(false);
    expect(sustained.byCategory.fatigue.criticalRules).toEqual([]);
  });

  it('separates the two shapes rather than reporting both on either', () => {
    // The pair is the point. A single elevated-heart-rate fixture that lit both cards would
    // mean the two rules are measuring the same thing under different names, and either one
    // could then be deleted without a test noticing.
    expect(drifting.byCategory.fatigue.rule).toBeNull();
    expect(sustained.byCategory.dehydration.rule).toBeNull();
  });
});
