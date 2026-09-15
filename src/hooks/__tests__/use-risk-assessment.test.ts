/**
 * The one line that decides whether the Dashboard scores real or simulated data.
 *
 * Everything else in this hook is a memo over pure functions that have their own tests. What
 * has to be pinned here is the *selection*: with the picker on Health Connect the engine must
 * see the feed's buffer and not the mock, with it on simulated it must see the mock and never
 * the feed, and the dev-only fall splice must work on both. A hook that silently kept reading
 * the mock would pass every other test in the repository.
 */

import { renderHook } from '@testing-library/react-native';

import { buildMockReadings } from '@/constants/mock-sensor-window';
import { useEnvironmentFeed } from '@/environment/provider';
import { useRiskAssessment } from '@/hooks/use-risk-assessment';
import type { SensorReading } from '@/risk';
import { useSensorFeed } from '@/sensors/provider';
import { useSettings } from '@/settings/provider';
import { DEFAULT_SETTINGS } from '@/settings/store';

jest.mock('@/environment/provider', () => ({ useEnvironmentFeed: jest.fn() }));
jest.mock('@/sensors/provider', () => ({ useSensorFeed: jest.fn() }));
jest.mock('@/settings/provider', () => ({ useSettings: jest.fn() }));

const environment = jest.mocked(useEnvironmentFeed);
const feed = jest.mocked(useSensorFeed);
const settings = jest.mocked(useSettings);

const NOW = 1_766_000_000_000;
const requestAccess = jest.fn();

const STILL = { peakG: 1.02, minG: 0.98, rmsG: 1.0, sampleCount: 1500 };

function liveReading(offsetMs: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp: NOW + offsetMs, hr: bpm };
}

function liveAt(offsetMs: number, fields: Partial<SensorReading>): SensorReading {
  return { source: 'health_connect', timestamp: NOW + offsetMs, ...fields };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  environment.mockReturnValue({
    environment: null,
    status: 'loading',
    failure: null,
    refreshing: false,
    refresh: jest.fn(),
  });
  feed.mockReturnValue({
    readings: [liveReading(-30_000, 131)],
    status: 'live',
    failure: null,
    lastPolledAt: NOW,
    requestAccess,
    refresh: jest.fn(),
  });
  settings.mockReturnValue({
    settings: { ...DEFAULT_SETTINGS, sensorSource: 'health_connect' },
    loaded: true,
    writeFailed: false,
    addContact: jest.fn(),
    removeContact: jest.fn(),
    setUserName: jest.fn(),
    setSharing: jest.fn(),
    setSensorSource: jest.fn(),
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useRiskAssessment source selection', () => {
  it('scores the live buffer when the source is health_connect', async () => {
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.live).toBe(true);
    expect(result.current.latest?.source).toBe('health_connect');
    expect(result.current.latest?.hr).toBe(131);
    expect(result.current.feedStatus).toBe('live');
    expect(result.current.requestAccess).toBe(requestAccess);
  });

  it('scores the simulated window when the source is simulated, ignoring the feed', async () => {
    settings.mockReturnValue({
      ...settings(),
      settings: { ...DEFAULT_SETTINGS, sensorSource: 'simulated' },
    });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.live).toBe(false);
    expect(result.current.latest).toEqual(buildMockReadings(NOW).at(-1));
    expect(result.current.assessment.sampleCount).toBeGreaterThan(1);
  });

  it('reports an empty live buffer as no latest reading rather than falling back to the mock', async () => {
    feed.mockReturnValue({ ...feed(), readings: [] });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.latest).toBeNull();
    expect(result.current.assessment.sampleCount).toBe(0);
  });

  it('composes latestVitals from the newest of each vital, not from the motion-only tail', async () => {
    // The live shape: HR and SpO₂ from the band, then the phone's motion summary stamped at the
    // poll instant. `latest` is that motion-only reading (the fall rule anchors on it); the SOS
    // message must still quote the vitals that are 30–45 s old.
    feed.mockReturnValue({
      ...feed(),
      readings: [
        liveAt(-30_000, { hr: 88 }),
        liveAt(-45_000, { spo2: 95 }),
        liveAt(0, { motionSummary: STILL }),
      ],
    });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.latest?.motionSummary).toBeDefined();
    expect(result.current.latest?.hr).toBeUndefined();
    expect(result.current.latestVitals?.hr).toBe(88);
    expect(result.current.latestVitals?.spo2).toBe(95);
    expect(result.current.latestVitals?.skinTempC).toBeUndefined();
    expect(result.current.latestVitals?.timestamp).toBe(NOW - 30_000);
  });

  it('reports no latestVitals when only motion has arrived', async () => {
    feed.mockReturnValue({ ...feed(), readings: [liveAt(0, { motionSummary: STILL })] });
    const { result } = await renderHook(() => useRiskAssessment());
    expect(result.current.latest).not.toBeNull();
    expect(result.current.latestVitals).toBeNull();
  });

  it('agrees latest and latestVitals on the simulated window, whose every reading carries all vitals', async () => {
    settings.mockReturnValue({
      ...settings(),
      settings: { ...DEFAULT_SETTINGS, sensorSource: 'simulated' },
    });
    const { result } = await renderHook(() => useRiskAssessment());
    const newest = buildMockReadings(NOW).at(-1);
    expect(result.current.latestVitals).toMatchObject({
      hr: newest?.hr,
      spo2: newest?.spo2,
      skinTempC: newest?.skinTempC,
      timestamp: newest?.timestamp,
    });
  });

  it('splices the simulated fall onto the live buffer under simulateFall', async () => {
    const { result } = await renderHook(() => useRiskAssessment({ simulateFall: true }));
    expect(result.current.live).toBe(true);
    expect(result.current.assessment.byCategory.fall.criticalRules).toContain(
      'fall.impactThenStillness',
    );
    expect(result.current.assessment.sosCandidate).toBe(true);
  });
});
