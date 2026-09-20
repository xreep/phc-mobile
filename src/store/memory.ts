/**
 * `ReadingStore` in process memory.
 *
 * Two jobs: the reference implementation the contract suite pins the SQLite store against, and
 * the runtime fallback when SQLite fails to open (`ReadingStoreProvider`) — the Dashboard keeps
 * working on a buffer that simply does not survive a restart, which is exactly what it did
 * before this store existed. Under Jest, where `expo-sqlite` is inert, every suite runs on this.
 *
 * Identity is the ring buffer's `identity()`; ordering is `compareStored`. No retention of its
 * own — `prune` is explicit, as it is for SQLite.
 */

import type { SensorReading } from '@/risk';
import { identity } from '@/sensors/ring-buffer';

import { cloneStored, compareStored, isStorable } from './reading';
import type { ReadingStore } from './types';

type Row = { readonly reading: SensorReading; readonly seq: number };

export class MemoryReadingStore implements ReadingStore {
  private readonly rows = new Map<string, Row>();
  private seq = 0;

  async append(readings: readonly SensorReading[]): Promise<void> {
    for (const reading of readings) {
      if (!isStorable(reading)) continue;
      const key = identity(reading);
      if (this.rows.has(key)) continue;
      this.rows.set(key, { reading: cloneStored(reading), seq: this.seq++ });
    }
  }

  async readSince(sinceMs: number, untilMs?: number): Promise<SensorReading[]> {
    const rows: Row[] = [];
    for (const row of this.rows.values()) {
      const { timestamp } = row.reading;
      if (timestamp < sinceMs) continue;
      if (untilMs !== undefined && timestamp > untilMs) continue;
      rows.push(row);
    }
    return rows.sort(compareStored).map((row) => cloneStored(row.reading));
  }

  async prune(olderThanMs: number): Promise<number> {
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (row.reading.timestamp < olderThanMs) {
        this.rows.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async clear(): Promise<void> {
    this.rows.clear();
  }

  async count(): Promise<number> {
    return this.rows.size;
  }
}
