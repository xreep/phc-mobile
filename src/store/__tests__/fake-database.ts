/**
 * A fake `SQLiteDatabase` for `SqliteReadingStore`'s tests.
 *
 * **What it is:** an in-memory table plus a statement log, behind the five methods the store
 * uses (`execAsync`, `runAsync`, `getFirstAsync`, `getAllAsync`, `withTransactionAsync`). It
 * recognises the store's statements *by exact text* and throws on anything else, so the SQL the
 * store emits is pinned here: a change to a query is a change to this file, in the open.
 *
 * **What it is not:** SQLite. The `ORDER BY`, the `WHERE` bounds, `INSERT OR IGNORE`'s
 * first-wins, and `PRAGMA user_version` are *simulated* to the letter of the SQL they stand
 * for. That the real driver behaves the same way is a device-validation item
 * (`docs/features/reading-store.md` → Device Validation), not something this file can prove.
 *
 * Not a test file itself (no `.test.` infix).
 */

import type { ReadingDatabase, SqliteBindValue } from '@/store/sqlite';

export type FakeRow = {
  id: number;
  key: string;
  ts: number;
  source: string;
  hr: number | null;
  spo2: number | null;
  skin_temp_c: number | null;
  peak_g: number | null;
  min_g: number | null;
  rms_g: number | null;
  sample_count: number | null;
};

export const INSERT_SQL =
  'INSERT OR IGNORE INTO readings (key, ts, source, hr, spo2, skin_temp_c, peak_g, min_g, rms_g, sample_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
export const SELECT_SINCE_SQL =
  'SELECT ts, source, hr, spo2, skin_temp_c, peak_g, min_g, rms_g, sample_count FROM readings WHERE ts >= ? ORDER BY ts ASC, (sample_count IS NOT NULL) ASC, id ASC';
export const SELECT_BETWEEN_SQL =
  'SELECT ts, source, hr, spo2, skin_temp_c, peak_g, min_g, rms_g, sample_count FROM readings WHERE ts >= ? AND ts <= ? ORDER BY ts ASC, (sample_count IS NOT NULL) ASC, id ASC';
export const PRUNE_SQL = 'DELETE FROM readings WHERE ts < ?';
export const CLEAR_SQL = 'DELETE FROM readings';
export const COUNT_SQL = 'SELECT COUNT(*) AS n FROM readings';
export const USER_VERSION_SQL = 'PRAGMA user_version';

type Failure = { readonly method: keyof ReadingDatabase; readonly error: Error };

export class FakeDatabase implements ReadingDatabase {
  /** Every statement executed, in order, including the transaction markers. */
  readonly statements: string[] = [];
  userVersion = 0;
  tableExists = false;
  rows: FakeRow[] = [];
  private nextId = 1;
  private failures: Failure[] = [];

  /** Make the next call to `method` throw `error` (once). */
  failNext(method: keyof ReadingDatabase, error = new Error(`${method} failed`)): void {
    this.failures.push({ method, error });
  }

  private maybeFail(method: keyof ReadingDatabase): void {
    const index = this.failures.findIndex((f) => f.method === method);
    if (index === -1) return;
    const [failure] = this.failures.splice(index, 1);
    throw failure.error;
  }

  async execAsync(source: string): Promise<void> {
    this.maybeFail('execAsync');
    for (const raw of source.split(';')) {
      const statement = raw.trim().replace(/\s+/g, ' ');
      if (statement.length === 0) continue;
      this.statements.push(statement);
      const version = /^PRAGMA user_version = (\d+)$/.exec(statement);
      if (version !== null) {
        this.userVersion = Number(version[1]);
        continue;
      }
      if (statement === 'PRAGMA journal_mode = WAL') continue;
      if (statement.startsWith('CREATE TABLE IF NOT EXISTS readings')) {
        this.tableExists = true;
        continue;
      }
      if (statement.startsWith('CREATE INDEX IF NOT EXISTS')) {
        if (!this.tableExists) throw new Error('no such table: readings');
        continue;
      }
      throw new Error(`FakeDatabase: unsupported exec statement: ${statement}`);
    }
  }

  async getFirstAsync<T>(source: string, params: SqliteBindValue[]): Promise<T | null> {
    this.maybeFail('getFirstAsync');
    this.statements.push(source);
    if (source === USER_VERSION_SQL) return { user_version: this.userVersion } as T;
    if (source === COUNT_SQL) {
      this.requireTable();
      return { n: this.rows.length } as T;
    }
    throw new Error(`FakeDatabase: unsupported getFirst statement: ${source} ${params.join(',')}`);
  }

  async runAsync(source: string, params: SqliteBindValue[]): Promise<{ changes: number }> {
    this.maybeFail('runAsync');
    this.statements.push(source);
    this.requireTable();
    if (source === INSERT_SQL) {
      const [key, ts, sourceName, hr, spo2, skinTempC, peakG, minG, rmsG, sampleCount] = params;
      if (typeof key !== 'string' || typeof ts !== 'number' || typeof sourceName !== 'string') {
        throw new Error('NOT NULL constraint failed');
      }
      // `INSERT OR IGNORE` against `UNIQUE(key)`: first wins, the duplicate is silently dropped.
      if (this.rows.some((row) => row.key === key)) return { changes: 0 };
      this.rows.push({
        id: this.nextId++,
        key,
        ts,
        source: sourceName,
        hr: asNullableNumber(hr),
        spo2: asNullableNumber(spo2),
        skin_temp_c: asNullableNumber(skinTempC),
        peak_g: asNullableNumber(peakG),
        min_g: asNullableNumber(minG),
        rms_g: asNullableNumber(rmsG),
        sample_count: asNullableNumber(sampleCount),
      });
      return { changes: 1 };
    }
    if (source === PRUNE_SQL) {
      const [cutoff] = params;
      if (typeof cutoff !== 'number') throw new Error('bad bind');
      const before = this.rows.length;
      this.rows = this.rows.filter((row) => !(row.ts < cutoff));
      return { changes: before - this.rows.length };
    }
    if (source === CLEAR_SQL) {
      const changes = this.rows.length;
      this.rows = [];
      return { changes };
    }
    throw new Error(`FakeDatabase: unsupported run statement: ${source}`);
  }

  async getAllAsync<T>(source: string, params: SqliteBindValue[]): Promise<T[]> {
    this.maybeFail('getAllAsync');
    this.statements.push(source);
    this.requireTable();
    let selected: FakeRow[];
    if (source === SELECT_SINCE_SQL) {
      const [since] = params;
      if (typeof since !== 'number') throw new Error('bad bind');
      selected = this.rows.filter((row) => row.ts >= since);
    } else if (source === SELECT_BETWEEN_SQL) {
      const [since, until] = params;
      if (typeof since !== 'number' || typeof until !== 'number') throw new Error('bad bind');
      selected = this.rows.filter((row) => row.ts >= since && row.ts <= until);
    } else {
      throw new Error(`FakeDatabase: unsupported getAll statement: ${source}`);
    }
    // `ORDER BY ts ASC, (sample_count IS NOT NULL) ASC, id ASC`, simulated.
    const ordered = [...selected].sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      const ma = a.sample_count !== null ? 1 : 0;
      const mb = b.sample_count !== null ? 1 : 0;
      if (ma !== mb) return ma - mb;
      return a.id - b.id;
    });
    // Column objects, as the driver returns them (no `id`, no `key`: the SELECT lists neither).
    return ordered.map(({ id: _id, key: _key, ...columns }) => ({ ...columns }) as T);
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.maybeFail('withTransactionAsync');
    this.statements.push('BEGIN');
    const snapshot = this.rows.map((row) => ({ ...row }));
    const snapshotId = this.nextId;
    try {
      await task();
      this.statements.push('COMMIT');
    } catch (error) {
      this.rows = snapshot;
      this.nextId = snapshotId;
      this.statements.push('ROLLBACK');
      throw error;
    }
  }

  private requireTable(): void {
    if (!this.tableExists) throw new Error('no such table: readings');
  }
}

function asNullableNumber(value: SqliteBindValue | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number') throw new Error(`bad bind: ${String(value)}`);
  return value;
}
