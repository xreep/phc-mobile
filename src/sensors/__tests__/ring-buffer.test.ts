/**
 * The live feed's ring buffer.
 *
 * Two boundaries are pinned exactly. The trim cutoff is inclusive at `now − retainMs`,
 * because the hook sizes `retainMs` from the engine's own `longestLookbackMs` plus headroom
 * and an off-by-one here would be an off-by-one in the safety rules' lookback. And re-reading
 * an overlapping Health Connect range must not double-count a sample — the tachycardia rule
 * counts sustained samples, and duplicates would let one reading satisfy it twice.
 */

import { mergeReadings } from '@/sensors/ring-buffer';
import type { SensorReading } from '@/risk';

const NOW = 1_766_000_000_000;
const MIN = 60_000;

function hr(offsetMs: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp: NOW + offsetMs, hr: bpm };
}

describe('mergeReadings', () => {
  it('appends, sorts ascending, and keeps the order stable at equal timestamps', () => {
    const motion: SensorReading = {
      source: 'health_connect',
      timestamp: NOW,
      motionSummary: { peakG: 1, minG: 1, rmsG: 1, sampleCount: 10 },
    };
    const out = mergeReadings([hr(-2 * MIN, 70)], [hr(0, 72), hr(-MIN, 71), motion], {
      now: NOW,
      retainMs: 10 * MIN,
    });
    expect(out.map((r) => r.timestamp - NOW)).toEqual([-2 * MIN, -MIN, 0, 0]);
    // The motion reading was appended last at its timestamp and must stay last: the fall rule
    // reads stillness from the newest reading.
    expect(out[3].motionSummary).toBeDefined();
  });

  it('drops a reading exactly older than the retention window and keeps one exactly at it', () => {
    const out = mergeReadings([], [hr(-10 * MIN - 1, 60), hr(-10 * MIN, 61)], {
      now: NOW,
      retainMs: 10 * MIN,
    });
    expect(out.map((r) => r.hr)).toEqual([61]);
  });

  it('trims readings already in the buffer, not only incoming ones', () => {
    const out = mergeReadings([hr(-30 * MIN, 60)], [], { now: NOW, retainMs: 10 * MIN });
    expect(out).toEqual([]);
  });

  it('deduplicates a sample that an overlapping re-read returned again', () => {
    const once = mergeReadings([], [hr(-MIN, 70)], { now: NOW, retainMs: 10 * MIN });
    const twice = mergeReadings(once, [hr(-MIN, 70)], { now: NOW, retainMs: 10 * MIN });
    expect(twice).toHaveLength(1);
  });

  it('keeps distinct vitals at the same instant as distinct readings', () => {
    const spo2: SensorReading = { source: 'health_connect', timestamp: NOW - MIN, spo2: 97 };
    const out = mergeReadings([], [hr(-MIN, 70), spo2], { now: NOW, retainMs: 10 * MIN });
    expect(out).toHaveLength(2);
  });

  it('does not mutate its inputs', () => {
    const buffer = [hr(-MIN, 70)];
    const incoming = [hr(0, 72)];
    mergeReadings(buffer, incoming, { now: NOW, retainMs: 10 * MIN });
    expect(buffer).toHaveLength(1);
    expect(incoming).toHaveLength(1);
  });
});
