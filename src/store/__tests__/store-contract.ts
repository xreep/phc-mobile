/**
 * The `ReadingStore` contract, as one suite run against every implementation.
 *
 * Both backends must agree on identity (a re-appended reading is a no-op), on order (ascending,
 * motion-bearing readings after vitals at equal instants — `rules/fall.ts` reads the trailing
 * still run from the *newest* reading, so a motion summary sorted under an HR sample at the
 * same instant would hide a fall), on inclusive bounds, and on what `prune` counts. The memory
 * store is the reference; the SQLite store must not be allowed to drift from it.
 *
 * Not a test file itself (no `.test.` infix): imported by `memory.test.ts` and `sqlite.test.ts`.
 */

import type { SensorReading } from '@/risk';
import type { ReadingStore } from '@/store/types';

export const T0 = 1_766_000_000_000;
export const MIN = 60_000;

export function hr(offsetMs: number, bpm: number): SensorReading {
  return { source: 'health_connect', timestamp: T0 + offsetMs, hr: bpm };
}

export function spo2(offsetMs: number, pct: number): SensorReading {
  return { source: 'health_connect', timestamp: T0 + offsetMs, spo2: pct };
}

export function skinTemp(offsetMs: number, c: number): SensorReading {
  return { source: 'health_connect', timestamp: T0 + offsetMs, skinTempC: c };
}

export function motion(offsetMs: number, sampleCount = 1500): SensorReading {
  return {
    source: 'health_connect',
    timestamp: T0 + offsetMs,
    motionSummary: { peakG: 1.02, minG: 0.98, rmsG: 1.0, sampleCount },
  };
}

export function storeContract(makeStore: () => Promise<ReadingStore> | ReadingStore) {
  let store: ReadingStore;

  beforeEach(async () => {
    store = await makeStore();
  });

  describe('append', () => {
    it('starts empty', async () => {
      await expect(store.count()).resolves.toBe(0);
      await expect(store.readSince(0)).resolves.toEqual([]);
    });

    it('stores every field of a reading and returns copies, not the caller’s objects', async () => {
      const full: SensorReading = {
        source: 'health_connect',
        timestamp: T0,
        hr: 72,
        spo2: 97,
        skinTempC: 33.4,
        motionSummary: { peakG: 2.4, minG: 0.1, rmsG: 1.1, sampleCount: 1234 },
      };
      await store.append([full]);
      const [back] = await store.readSince(T0);
      expect(back).toEqual(full);
      expect(back).not.toBe(full);
      expect(back.motionSummary).not.toBe(full.motionSummary);
    });

    it('is a no-op for an identical reading appended twice, in one call or across calls', async () => {
      await store.append([hr(0, 72), hr(0, 72)]);
      await store.append([hr(0, 72)]);
      await expect(store.count()).resolves.toBe(1);
    });

    it('keeps first-wins on a re-read that returns the same sample', async () => {
      await store.append([hr(0, 72)]);
      await store.append([hr(0, 73)]);
      await expect(store.readSince(0)).resolves.toEqual([hr(0, 72)]);
    });

    it('treats readings at one instant carrying different vitals as distinct', async () => {
      await store.append([hr(0, 72), spo2(0, 97), skinTemp(0, 33), motion(0)]);
      await expect(store.count()).resolves.toBe(4);
    });

    it('treats the same instant from different sources as distinct', async () => {
      await store.append([hr(0, 72), { source: 'simulated', timestamp: T0, hr: 72 }]);
      await expect(store.count()).resolves.toBe(2);
    });

    it('accepts an empty batch', async () => {
      await store.append([]);
      await expect(store.count()).resolves.toBe(0);
    });

    it('does not persist a reading that carries nothing storable (raw vector only)', async () => {
      // Raw `motion` vectors are not persisted (no adapter emits them; the fold produces
      // summaries), so a reading that is *only* a raw vector has no row to write.
      await store.append([{ source: 'health_connect', timestamp: T0, motion: { x: 0, y: 0, z: 1 } }]);
      await expect(store.count()).resolves.toBe(0);
    });
  });

  describe('readSince', () => {
    it('returns ascending regardless of insertion order', async () => {
      await store.append([hr(2 * MIN, 3), hr(0, 1), hr(MIN, 2)]);
      const out = await store.readSince(0);
      expect(out.map((r) => r.hr)).toEqual([1, 2, 3]);
    });

    it('places motion after vitals at an equal instant, whichever was appended first', async () => {
      await store.append([motion(0), hr(0, 72), spo2(0, 97)]);
      const out = await store.readSince(0);
      expect(out).toHaveLength(3);
      expect(out[2].motionSummary).toBeDefined();
      expect(out[0].motionSummary).toBeUndefined();
      expect(out[1].motionSummary).toBeUndefined();
    });

    it('is inclusive at both bounds', async () => {
      await store.append([hr(-1, 1), hr(0, 2), hr(MIN, 3), hr(MIN + 1, 4)]);
      const out = await store.readSince(T0, T0 + MIN);
      expect(out.map((r) => r.hr)).toEqual([2, 3]);
    });

    it('has no upper bound when untilMs is omitted', async () => {
      await store.append([hr(0, 1), hr(10 * MIN, 2)]);
      const out = await store.readSince(T0);
      expect(out.map((r) => r.hr)).toEqual([1, 2]);
    });

    it('returns a fresh array on every call', async () => {
      await store.append([hr(0, 1)]);
      const a = await store.readSince(0);
      const b = await store.readSince(0);
      expect(a).toEqual(b);
      expect(a).not.toBe(b);
      expect(a[0]).not.toBe(b[0]);
    });
  });

  describe('prune', () => {
    it('deletes strictly older readings and returns how many', async () => {
      await store.append([hr(-2 * MIN, 1), hr(-MIN, 2), hr(0, 3), hr(MIN, 4)]);
      await expect(store.prune(T0)).resolves.toBe(2);
      const out = await store.readSince(0);
      expect(out.map((r) => r.hr)).toEqual([3, 4]);
    });

    it('keeps a reading exactly at the cutoff', async () => {
      await store.append([hr(0, 1)]);
      await expect(store.prune(T0)).resolves.toBe(0);
      await expect(store.count()).resolves.toBe(1);
    });

    it('returns 0 on an empty store', async () => {
      await expect(store.prune(T0)).resolves.toBe(0);
    });
  });

  describe('clear', () => {
    it('erases everything', async () => {
      await store.append([hr(0, 1), motion(0)]);
      await store.clear();
      await expect(store.count()).resolves.toBe(0);
      await expect(store.readSince(0)).resolves.toEqual([]);
    });

    it('accepts new readings afterwards', async () => {
      await store.append([hr(0, 1)]);
      await store.clear();
      await store.append([hr(0, 1)]);
      await expect(store.count()).resolves.toBe(1);
    });
  });
}
