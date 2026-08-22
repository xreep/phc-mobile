/**
 * Pins the demo sensor window and the assessment the Dashboard renders from it.
 *
 * Two jobs. The first is ordinary regression cover: the Home screen's cards are now
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
 */

import { ENVIRONMENT, VITALS } from '@/constants/health-data';
import {
  buildMockEnvironment,
  buildMockReadings,
  MOCK_WINDOW,
} from '@/constants/mock-sensor-window';
import { assessRisk, DEFAULT_RISK_THRESHOLDS as T } from '@/risk';
import type { SensorReading } from '@/risk';

/** Fixed instant, so every expectation below is exact. */
const NOW = 1_766_000_000_000;

const readings = buildMockReadings(NOW);
const environment = buildMockEnvironment(NOW);
const assessment = assessRisk({ readings, environment, now: NOW });

const newest = readings[readings.length - 1];

describe('mock sensor window', () => {
  it('is a pure function of `now`', () => {
    expect(buildMockReadings(NOW)).toEqual(readings);
    expect(buildMockEnvironment(NOW)).toEqual(environment);

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
    // `assess.ts` clamps to max(window.ms, heatCriticalMs + maxGapMs, fall.stillnessWindowMs).
    // A window shorter than that leaves the extended-lookback rules quietly reading a
    // truncated buffer rather than erroring.
    const longestLookbackMs = Math.max(
      T.window.ms,
      T.stillness.heatCriticalMs + T.window.maxGapMs,
      T.fall.stillnessWindowMs,
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

  it('forwards only the environment fields the engine consumes', () => {
    expect(environment).toEqual({
      tempC: ENVIRONMENT.tempC,
      humidity: ENVIRONMENT.humidity,
      heatIndexC: ENVIRONMENT.heatIndexC,
      aqi: ENVIRONMENT.aqi,
      observedAt: NOW - MOCK_WINDOW.environmentAgeMs,
    });
    expect(MOCK_WINDOW.environmentAgeMs).toBeLessThan(T.env.maxStaleMs);
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
    expect(assessment.heatIndexC).toBe(ENVIRONMENT.heatIndexC);
    expect(assessment.heatIndexBand?.label).toBe('Extreme Danger');
    expect(assessment.heatIndexOutOfDomain).toBe(false);
  });

  it('produces the four cards in dashboard order', () => {
    expect(assessment.categories.map((c) => c.key)).toEqual([
      'heat',
      'respiratory',
      'cardiovascular',
      'fall',
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
    ]);
  });

  it('scores heat in the red band and leaves the rest at zero', () => {
    expect(assessment.byCategory.heat.score).toBeGreaterThanOrEqual(90);
    expect(assessment.byCategory.respiratory.score).toBe(0);
    expect(assessment.byCategory.cardiovascular.score).toBe(0);
    expect(assessment.byCategory.fall.score).toBe(0);
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
});
