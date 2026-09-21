/**
 * `ReadingStore` on `expo-sqlite` (SDK 57, `openDatabaseAsync` API).
 *
 * ## Where the file lives
 * `openDatabaseAsync('phc.db')` puts the file in expo-sqlite's default database directory,
 * which is inside the app's private storage (`/data/data/<package>/…` on Android): other apps
 * cannot read it without root, and it is deleted with the app. It is **plaintext** today —
 * encryption (SQLCipher-class, key in the Android Keystore) is a later milestone, ADR-006 —
 * which is why the "Erase my health data" control ships with this store rather than after it.
 *
 * ## Schema (v1)
 * One row per reading; a NULL column means "this reading did not carry that vital". The row's
 * `key` is the ring buffer's `identity()` string and is the UNIQUE column. A UNIQUE constraint
 * over the nullable vitals columns would *not* work: SQLite treats NULLs as distinct inside
 * UNIQUE, so every motion-only reading (all vitals NULL) would insert twice.
 *
 * Raw `motion` vectors are not persisted — only the fold's `motionSummary` (peak/min/rms/count)
 * is (`reading.ts`).
 *
 * ## Migrations
 * `PRAGMA user_version` (the pattern the expo-sqlite docs show): 0 is a fresh file, each step
 * raises it by one, and a file from a newer app version is refused rather than misread.
 *
 * ## Errors
 * Every method rejects with a `ReadingStoreError` (cause attached); the hook catches it and
 * keeps the Dashboard on its in-memory buffer.
 *
 * ## Testing
 * The SQL layer is tested against a fake `SQLiteDatabase` that recognises these statements by
 * text (`__tests__/fake-database.ts`). The real driver is device-validated, not unit-tested.
 */

import { openDatabaseAsync, type SQLiteBindValue } from 'expo-sqlite';

import type { SensorReading } from '@/risk';
import { identity } from '@/sensors/ring-buffer';

import { isStorable } from './reading';
import { ReadingStoreError, type ReadingStore } from './types';

export const DATABASE_NAME = 'phc.db';
export const SCHEMA_VERSION = 1;

export type SqliteBindValue = SQLiteBindValue;

/**
 * The slice of `SQLiteDatabase` the store uses, as a structural type so a test can hand in a
 * fake and so the store is pinned to exactly these five calls.
 */
export interface ReadingDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqliteBindValue[]): Promise<{ changes: number }>;
  getFirstAsync<T>(source: string, params: SqliteBindValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, params: SqliteBindValue[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  hr REAL,
  spo2 REAL,
  skin_temp_c REAL,
  peak_g REAL,
  min_g REAL,
  rms_g REAL,
  sample_count INTEGER
);
CREATE INDEX IF NOT EXISTS readings_ts ON readings (ts);
PRAGMA user_version = 1;
`;

const INSERT_SQL =
  'INSERT OR IGNORE INTO readings (key, ts, source, hr, spo2, skin_temp_c, peak_g, min_g, rms_g, sample_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const SELECT_COLUMNS = 'SELECT ts, source, hr, spo2, skin_temp_c, peak_g, min_g, rms_g, sample_count FROM readings';
// Vitals before motion at an equal instant, then insertion order — see `reading.ts`.
const ORDER = 'ORDER BY ts ASC, (sample_count IS NOT NULL) ASC, id ASC';
const SELECT_SINCE_SQL = `${SELECT_COLUMNS} WHERE ts >= ? ${ORDER}`;
const SELECT_BETWEEN_SQL = `${SELECT_COLUMNS} WHERE ts >= ? AND ts <= ? ${ORDER}`;
const PRUNE_SQL = 'DELETE FROM readings WHERE ts < ?';
const CLEAR_SQL = 'DELETE FROM readings';
const COUNT_SQL = 'SELECT COUNT(*) AS n FROM readings';

type Row = {
  readonly ts: number;
  readonly source: SensorReading['source'];
  readonly hr: number | null;
  readonly spo2: number | null;
  readonly skin_temp_c: number | null;
  readonly peak_g: number | null;
  readonly min_g: number | null;
  readonly rms_g: number | null;
  readonly sample_count: number | null;
};

function toParams(reading: SensorReading): SqliteBindValue[] {
  const motion = reading.motionSummary;
  return [
    identity(reading),
    reading.timestamp,
    reading.source,
    reading.hr ?? null,
    reading.spo2 ?? null,
    reading.skinTempC ?? null,
    motion?.peakG ?? null,
    motion?.minG ?? null,
    motion?.rmsG ?? null,
    motion?.sampleCount ?? null,
  ];
}

function toReading(row: Row): SensorReading {
  const reading: { -readonly [K in keyof SensorReading]?: SensorReading[K] } = {
    source: row.source,
    timestamp: row.ts,
  };
  if (row.hr !== null) reading.hr = row.hr;
  if (row.spo2 !== null) reading.spo2 = row.spo2;
  if (row.skin_temp_c !== null) reading.skinTempC = row.skin_temp_c;
  if (row.sample_count !== null && row.peak_g !== null && row.min_g !== null && row.rms_g !== null) {
    reading.motionSummary = {
      peakG: row.peak_g,
      minG: row.min_g,
      rmsG: row.rms_g,
      sampleCount: row.sample_count,
    };
  }
  return reading as SensorReading;
}

async function guard<T>(operation: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw new ReadingStoreError(operation, error);
  }
}

/** Bring `db` to `SCHEMA_VERSION`. Idempotent; refuses a newer file. */
async function migrate(db: ReadingDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version', []);
  const version = row?.user_version ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `database schema v${version} is newer than this app supports (v${SCHEMA_VERSION})`,
    );
  }
  if (version < 1) await db.execAsync(SCHEMA_V1);
}

export class SqliteReadingStore implements ReadingStore {
  constructor(private readonly db: ReadingDatabase) {}

  async append(readings: readonly SensorReading[]): Promise<void> {
    const rows = readings.filter(isStorable).map(toParams);
    if (rows.length === 0) return;
    await guard('append', () =>
      this.db.withTransactionAsync(async () => {
        for (const params of rows) await this.db.runAsync(INSERT_SQL, params);
      }),
    );
  }

  async readSince(sinceMs: number, untilMs?: number): Promise<SensorReading[]> {
    const rows = await guard('readSince', () =>
      untilMs === undefined
        ? this.db.getAllAsync<Row>(SELECT_SINCE_SQL, [sinceMs])
        : this.db.getAllAsync<Row>(SELECT_BETWEEN_SQL, [sinceMs, untilMs]),
    );
    return rows.map(toReading);
  }

  async prune(olderThanMs: number): Promise<number> {
    const result = await guard('prune', () => this.db.runAsync(PRUNE_SQL, [olderThanMs]));
    return result.changes;
  }

  async clear(): Promise<void> {
    await guard('clear', () => this.db.runAsync(CLEAR_SQL, []));
  }

  async count(): Promise<number> {
    const row = await guard('count', () => this.db.getFirstAsync<{ n: number }>(COUNT_SQL, []));
    return row?.n ?? 0;
  }
}

export type OpenSqliteReadingStoreOptions = {
  /** Test seam. Defaults to `expo-sqlite`'s `openDatabaseAsync(DATABASE_NAME)`. */
  readonly openDatabase?: () => Promise<ReadingDatabase>;
};

/** Open (creating if needed) and migrate the app-private database. Rejects with `ReadingStoreError`. */
export async function openSqliteReadingStore({
  openDatabase = () => openDatabaseAsync(DATABASE_NAME),
}: OpenSqliteReadingStoreOptions = {}): Promise<SqliteReadingStore> {
  const db = await guard('open', openDatabase);
  await guard('migrate', () => migrate(db));
  return new SqliteReadingStore(db);
}
