/**
 * The persistent reading store's contract (PS §5 local processing; PRD §7.2.1 buffer, §7 trends).
 *
 * The live feed's ring buffer is React state: kill the app and the last twenty minutes are
 * gone, and nothing older than the engine's lookback is ever kept. This store is the system of
 * record underneath it — the hook appends what it polls, then reads its buffer back from here,
 * and up to {@link HISTORY_RETAIN_MS} of readings stay on the phone for the Trends screen and
 * the multi-day baselines that follow (M7+).
 *
 * ## Two rules every implementation is bound by
 * 1. **Local only.** Nothing in this module talks to a network. The SQLite file lives in the
 *    app's private storage; the memory implementation lives in the process. No health data
 *    leaves the device except an SOS payload (PRD §7.2.6), and that path does not read this
 *    store.
 * 2. **Simulated readings are never written.** The hook only appends when it is polling Health
 *    Connect, so demo data (Settings → "Simulated data", the dev "Simulate a fall" splice)
 *    never contaminates real history. The store does not enforce this itself — it cannot tell
 *    a demo reading from a real one — so the guarantee is the hook's, and it is tested there.
 *
 * ## Identity
 * `append` is idempotent on the ring buffer's `identity()`: the instant, the source, and
 * *which* vitals the reading carries (not their values). Health Connect re-reads over an
 * overlapping range return the same sample with the same value, so first-wins is correct and
 * the store and the in-memory `mergeReadings` agree on what "already held" means.
 */

import type { SensorReading } from '@/risk';

/**
 * How long readings stay in the store: 7 days, the baseline window PRD §7.2.2 asks for
 * ("resting HR over the past 7 days") and the longest range the Trends screen shows. The
 * hook prunes to this once per poll. Trends and baselines read from the store, never from the
 * feed's ~20-minute buffer.
 */
export const HISTORY_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;

export type ReadingStoreBackend = 'sqlite' | 'memory';

/**
 * Every method resolves with fresh copies — a caller may mutate what it gets back without
 * reaching into the store — and every method may reject with a {@link ReadingStoreError}, which
 * the hook catches so a failed write never stops the Dashboard scoring the in-memory buffer.
 */
export interface ReadingStore {
  /**
   * Persist readings. Idempotent on identity: a reading already held is skipped, and two
   * identical readings in one batch persist once. A reading carrying nothing storable (only a
   * raw `motion` vector, which is not persisted) is dropped.
   */
  append(readings: readonly SensorReading[]): Promise<void>;
  /**
   * Readings with `sinceMs ≤ timestamp ≤ untilMs`, ascending; at an equal instant, readings
   * carrying a motion summary come after those carrying vitals, so the newest reading at the
   * poll instant is the motion reading (`rules/fall.ts` depends on this). No upper bound when
   * `untilMs` is omitted.
   */
  readSince(sinceMs: number, untilMs?: number): Promise<SensorReading[]>;
  /** Delete readings with `timestamp < olderThanMs`. Resolves with how many were deleted. */
  prune(olderThanMs: number): Promise<number>;
  /** Erase every reading. The "Erase my health data" control. */
  clear(): Promise<void>;
  count(): Promise<number>;
}

/** Thrown (rejected) by every store method on failure; `cause` carries the driver's error. */
export class ReadingStoreError extends Error {
  readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error && cause.message.length > 0 ? `: ${cause.message}` : '';
    super(`Reading store ${operation} failed${detail}`);
    this.name = 'ReadingStoreError';
    this.cause = cause;
  }
}
