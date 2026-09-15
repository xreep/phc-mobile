/**
 * Health Connect → `SensorReading` mapping.
 *
 * The one property that matters most here is negative: a vital the record does not carry must
 * come out `undefined`, never `0`. `risk/types.ts` spells out why — the engine reads `spo2: 0`
 * as catastrophic hypoxia and would fire an emergency on it. Skin temperature is where that
 * bites in practice, because Health Connect stores it as *deltas* from an optional baseline,
 * and a delta on its own is not a temperature.
 */

import {
  mapHeartRate,
  mapOxygenSaturation,
  mapSkinTemperature,
} from '@/sensors/health-connect';

const T = '2026-09-15T10:00:00.000Z';
const T_MS = Date.parse(T);

describe('mapHeartRate', () => {
  it('fans every sample of every record out into its own reading', () => {
    const readings = mapHeartRate([
      {
        samples: [
          { time: T, beatsPerMinute: 72 },
          { time: '2026-09-15T10:00:01.000Z', beatsPerMinute: 74 },
        ],
      },
      { samples: [{ time: '2026-09-15T10:00:02.000Z', beatsPerMinute: 75 }] },
    ]);

    expect(readings).toEqual([
      { source: 'health_connect', timestamp: T_MS, hr: 72 },
      { source: 'health_connect', timestamp: T_MS + 1000, hr: 74 },
      { source: 'health_connect', timestamp: T_MS + 2000, hr: 75 },
    ]);
  });

  it('carries no other vital on the reading', () => {
    const [reading] = mapHeartRate([{ samples: [{ time: T, beatsPerMinute: 72 }] }]);
    expect(reading).not.toHaveProperty('spo2');
    expect(reading).not.toHaveProperty('skinTempC');
  });

  it('drops samples whose instant does not parse', () => {
    expect(mapHeartRate([{ samples: [{ time: 'not a date', beatsPerMinute: 72 }] }])).toEqual([]);
  });

  it('drops non-finite values rather than emitting a number the engine would trust', () => {
    expect(mapHeartRate([{ samples: [{ time: T, beatsPerMinute: Number.NaN }] }])).toEqual([]);
  });
});

describe('mapOxygenSaturation', () => {
  it('maps one instantaneous record to one reading', () => {
    expect(mapOxygenSaturation([{ time: T, percentage: 97 }])).toEqual([
      { source: 'health_connect', timestamp: T_MS, spo2: 97 },
    ]);
  });

  it('never substitutes 0 for a missing percentage', () => {
    expect(mapOxygenSaturation([{ time: T, percentage: Number.NaN }])).toEqual([]);
  });
});

describe('mapSkinTemperature', () => {
  it('adds each delta to the baseline when a baseline is present', () => {
    const readings = mapSkinTemperature([
      {
        baseline: { inCelsius: 33.5, inFahrenheit: 92.3 },
        deltas: [
          { time: T, delta: { inCelsius: 0.4, inFahrenheit: 0.72 } },
          { time: '2026-09-15T10:01:00.000Z', delta: { inCelsius: -0.2, inFahrenheit: -0.36 } },
        ],
      },
    ]);

    expect(readings).toHaveLength(2);
    expect(readings[0]).toEqual({ source: 'health_connect', timestamp: T_MS, skinTempC: 33.9 });
    expect(readings[1].skinTempC).toBeCloseTo(33.3, 6);
  });

  it('emits nothing when there is no baseline — a delta alone is not a temperature', () => {
    expect(
      mapSkinTemperature([
        { deltas: [{ time: T, delta: { inCelsius: 0.4, inFahrenheit: 0.72 } }] },
      ]),
    ).toEqual([]);
  });

  it('emits nothing for a record with a baseline and no deltas', () => {
    expect(
      mapSkinTemperature([{ baseline: { inCelsius: 33.5, inFahrenheit: 92.3 }, deltas: [] }]),
    ).toEqual([]);
  });
});

import { Platform } from 'react-native';
import {
  getGrantedPermissions,
  getSdkStatus,
  initialize,
  readRecords,
  requestPermission,
} from 'react-native-health-connect';

import {
  checkHealthConnect,
  grantedVitalsPermissions,
  readVitals,
  requestVitalsAccess,
  VITALS_PERMISSIONS,
} from '@/sensors/health-connect';

const sdkStatus = jest.mocked(getSdkStatus);
const init = jest.mocked(initialize);
const granted = jest.mocked(getGrantedPermissions);
const request = jest.mocked(requestPermission);
const read = jest.mocked(readRecords);

// jest-expo's `haste.defaultPlatform` is `ios` (react-native's own jest setup sets
// `Platform.OS = 'ios'` to match), not `android` — so every test here needs Android
// forced on as its baseline, with the one "off Android" test below overriding it back to
// iOS for its own duration. Without this, `checkHealthConnect` would short-circuit to
// 'unavailable' before ever calling the mocked SDK functions, regardless of their mocks.
let platformOS: typeof Platform.OS;

beforeEach(() => {
  platformOS = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });

  sdkStatus.mockReset().mockResolvedValue(3);
  init.mockReset().mockResolvedValue(true);
  granted.mockReset().mockResolvedValue([]);
  request.mockReset().mockResolvedValue([]);
  read.mockReset().mockResolvedValue({ records: [] });
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: platformOS, configurable: true });
});

describe('checkHealthConnect', () => {
  it('is available only when the SDK reports available and initialises', async () => {
    await expect(checkHealthConnect()).resolves.toBe('available');
    expect(init).toHaveBeenCalledTimes(1);
  });

  it('reports update-required distinctly, so the notice can say what to do', async () => {
    sdkStatus.mockResolvedValue(2);
    await expect(checkHealthConnect()).resolves.toBe('update-required');
    expect(init).not.toHaveBeenCalled();
  });

  it('is unavailable when the SDK is absent', async () => {
    sdkStatus.mockResolvedValue(1);
    await expect(checkHealthConnect()).resolves.toBe('unavailable');
  });

  it('is unavailable when initialise fails even though the SDK is present', async () => {
    init.mockResolvedValue(false);
    await expect(checkHealthConnect()).resolves.toBe('unavailable');
  });

  it('never calls the native module off Android', async () => {
    const os = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    try {
      await expect(checkHealthConnect()).resolves.toBe('unavailable');
      expect(sdkStatus).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
    }
  });
});

describe('permissions', () => {
  it('asks for read access to exactly the three vitals record types', async () => {
    await requestVitalsAccess();
    expect(request).toHaveBeenCalledWith([
      { accessType: 'read', recordType: 'HeartRate' },
      { accessType: 'read', recordType: 'OxygenSaturation' },
      { accessType: 'read', recordType: 'SkinTemperature' },
    ]);
    expect(VITALS_PERMISSIONS).toHaveLength(3);
  });

  it('reports only the vitals read permissions that were granted, ignoring unrelated grants', async () => {
    granted.mockResolvedValue([
      { accessType: 'read', recordType: 'HeartRate' },
      { accessType: 'write', recordType: 'OxygenSaturation' },
      { accessType: 'read', recordType: 'Steps' },
    ]);
    await expect(grantedVitalsPermissions()).resolves.toEqual(['HeartRate']);
  });

  it('returns the post-dialog grant set from requestVitalsAccess', async () => {
    request.mockResolvedValue([{ accessType: 'read', recordType: 'OxygenSaturation' }]);
    await expect(requestVitalsAccess()).resolves.toEqual(['OxygenSaturation']);
  });
});

describe('readVitals', () => {
  const SINCE = Date.parse('2026-09-15T09:42:00.000Z');
  const UNTIL = Date.parse('2026-09-15T10:00:00.000Z');

  it('reads only the granted record types, over the requested range, ascending', async () => {
    await readVitals({ sinceMs: SINCE, untilMs: UNTIL, granted: ['HeartRate', 'SkinTemperature'] });

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith('HeartRate', {
      timeRangeFilter: {
        operator: 'between',
        startTime: '2026-09-15T09:42:00.000Z',
        endTime: '2026-09-15T10:00:00.000Z',
      },
      ascendingOrder: true,
    });
    expect(read).toHaveBeenCalledWith('SkinTemperature', expect.anything());
    expect(read).not.toHaveBeenCalledWith('OxygenSaturation', expect.anything());
  });

  it('reads nothing when nothing is granted', async () => {
    await expect(readVitals({ sinceMs: SINCE, untilMs: UNTIL, granted: [] })).resolves.toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('merges every record type into one ascending list', async () => {
    read.mockImplementation((recordType) => {
      if (recordType === 'HeartRate') {
        return Promise.resolve({
          records: [
            {
              samples: [{ time: '2026-09-15T09:59:30.000Z', beatsPerMinute: 80 }],
            },
          ],
        } as never);
      }
      if (recordType === 'OxygenSaturation') {
        return Promise.resolve({
          records: [{ time: '2026-09-15T09:59:00.000Z', percentage: 96 }],
        } as never);
      }
      return Promise.resolve({ records: [] } as never);
    });

    const readings = await readVitals({
      sinceMs: SINCE,
      untilMs: UNTIL,
      granted: ['HeartRate', 'OxygenSaturation', 'SkinTemperature'],
    });

    expect(readings.map((r) => [r.timestamp, r.hr, r.spo2])).toEqual([
      [Date.parse('2026-09-15T09:59:00.000Z'), undefined, 96],
      [Date.parse('2026-09-15T09:59:30.000Z'), 80, undefined],
    ]);
  });

  it('propagates a read failure so the hook can report it', async () => {
    read.mockRejectedValue(new Error('boom'));
    await expect(
      readVitals({ sinceMs: SINCE, untilMs: UNTIL, granted: ['HeartRate'] }),
    ).rejects.toThrow('boom');
  });
});
