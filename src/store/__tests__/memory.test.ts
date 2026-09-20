/**
 * `MemoryReadingStore` — the reference implementation of the contract, and what the app runs
 * on when SQLite fails to open (and under every Jest suite, where `expo-sqlite` is inert).
 */

import { MemoryReadingStore } from '@/store/memory';
import { identity } from '@/sensors/ring-buffer';

import { hr, motion, storeContract, T0 } from './store-contract';

describe('MemoryReadingStore', () => {
  storeContract(() => new MemoryReadingStore());

  it('keys identity exactly as the ring buffer does, so the two never disagree', async () => {
    // The hook's in-memory `mergeReadings` and the store must dedupe the same way: a reading
    // the buffer already holds is a reading the store already holds.
    const store = new MemoryReadingStore();
    await store.append([hr(0, 72)]);
    await store.append([{ ...hr(0, 72), hr: 99 }]);
    await expect(store.count()).resolves.toBe(1);
    expect(identity(hr(0, 72))).toBe(identity({ ...hr(0, 72), hr: 99 }));
  });

  it('does not leak the caller’s objects into later reads', async () => {
    const store = new MemoryReadingStore();
    const reading = motion(0);
    await store.append([reading]);
    (reading as { timestamp: number }).timestamp = T0 + 1;
    const [back] = await store.readSince(0);
    expect(back.timestamp).toBe(T0);
  });
});
