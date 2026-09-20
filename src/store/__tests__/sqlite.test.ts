/**
 * `SqliteReadingStore` against a fake `SQLiteDatabase` (`fake-database.ts`).
 *
 * What is provable here: the migration the store runs on a fresh file and skips on a current
 * one, that a batch goes through one transaction and rolls back whole, the exact SQL text (the
 * fake rejects anything else), that NULL-bearing rows dedupe on the `key` column, and that
 * every driver failure surfaces as a `ReadingStoreError`. The contract suite runs on top, so
 * ordering and bounds match the memory store's to the reading.
 *
 * What is **not** provable here: that the real `expo-sqlite` driver on a phone does what the
 * fake simulates. That is a device-validation item; the feature doc says so.
 */

import { openDatabaseAsync } from 'expo-sqlite';

import { identity } from '@/sensors/ring-buffer';
import {
  DATABASE_NAME,
  openSqliteReadingStore,
  SCHEMA_VERSION,
  SqliteReadingStore,
} from '@/store/sqlite';
import { ReadingStoreError } from '@/store/types';

import { FakeDatabase, INSERT_SQL } from './fake-database';
import { hr, motion, storeContract, T0 } from './store-contract';

async function openFake(db = new FakeDatabase()) {
  const store = await openSqliteReadingStore({ openDatabase: async () => db });
  return { db, store };
}

describe('SqliteReadingStore', () => {
  storeContract(async () => (await openFake()).store);

  describe('opening', () => {
    it('opens the app-private database by name through expo-sqlite by default', async () => {
      // The global Jest shim rejects, which is the fallback path the provider handles; here it
      // pins that the default opener is `openDatabaseAsync('phc.db')` and nothing else.
      const mocked = jest.mocked(openDatabaseAsync);
      mocked.mockClear();
      await expect(openSqliteReadingStore()).rejects.toBeInstanceOf(ReadingStoreError);
      expect(mocked).toHaveBeenCalledWith(DATABASE_NAME);
      expect(DATABASE_NAME).toBe('phc.db');
    });

    it('migrates a fresh database to schema v1 with WAL, the table, the index, and the version', async () => {
      const { db } = await openFake();
      expect(db.userVersion).toBe(SCHEMA_VERSION);
      expect(db.tableExists).toBe(true);
      expect(db.statements[0]).toBe('PRAGMA journal_mode = WAL');
      expect(db.statements).toContain('PRAGMA user_version');
      const createTable = db.statements.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS readings'));
      expect(createTable).toBeDefined();
      expect(db.statements.some((s) => s.startsWith('CREATE INDEX IF NOT EXISTS') && s.includes('(ts)'))).toBe(true);
      expect(db.statements).toContain(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });

    it('dedupes on a NOT NULL key column, never on nullable vitals columns', async () => {
      // SQLite treats NULLs as distinct inside a UNIQUE constraint, so a UNIQUE over
      // (ts, source, hr, spo2, …) would let every motion-only reading (all vitals NULL) insert
      // twice. The identity string is the unique column instead.
      const { db } = await openFake();
      const createTable = db.statements.find((s) => s.startsWith('CREATE TABLE'))!;
      expect(createTable).toMatch(/key TEXT NOT NULL UNIQUE/);
      expect(createTable).not.toMatch(/UNIQUE\s*\(/);
    });

    it('does not re-run the migration on a database already at the current version', async () => {
      const db = new FakeDatabase();
      await openFake(db);
      const before = db.statements.length;
      await openFake(db);
      const after = db.statements.slice(before);
      expect(after).toEqual(['PRAGMA journal_mode = WAL', 'PRAGMA user_version']);
    });

    it('refuses a database written by a newer app version rather than guessing at its schema', async () => {
      const db = new FakeDatabase();
      db.tableExists = true;
      db.userVersion = SCHEMA_VERSION + 1;
      await expect(openFake(db)).rejects.toThrow(/newer/);
      await expect(openFake(db)).rejects.toBeInstanceOf(ReadingStoreError);
    });

    it('wraps an open failure', async () => {
      const cause = new Error('disk I/O error');
      await expect(
        openSqliteReadingStore({ openDatabase: async () => { throw cause; } }),
      ).rejects.toMatchObject({ name: 'ReadingStoreError', cause });
    });

    it('wraps a migration failure', async () => {
      const db = new FakeDatabase();
      db.failNext('execAsync', new Error('database is locked'));
      await expect(openFake(db)).rejects.toMatchObject({
        name: 'ReadingStoreError',
        message: expect.stringContaining('database is locked'),
      });
    });
  });

  describe('append', () => {
    it('writes the batch as INSERT OR IGNORE rows inside one transaction', async () => {
      const { db, store } = await openFake();
      db.statements.length = 0;
      await store.append([hr(0, 72), hr(60_000, 73), motion(60_000)]);
      expect(db.statements).toEqual(['BEGIN', INSERT_SQL, INSERT_SQL, INSERT_SQL, 'COMMIT']);
    });

    it('binds the ring-buffer identity as the key and NULL for absent columns', async () => {
      const { db, store } = await openFake();
      await store.append([hr(0, 72), motion(0, 1500)]);
      expect(db.rows).toEqual([
        {
          id: 1,
          key: identity(hr(0, 72)),
          ts: T0,
          source: 'health_connect',
          hr: 72,
          spo2: null,
          skin_temp_c: null,
          peak_g: null,
          min_g: null,
          rms_g: null,
          sample_count: null,
        },
        {
          id: 2,
          key: identity(motion(0)),
          ts: T0,
          source: 'health_connect',
          hr: null,
          spo2: null,
          skin_temp_c: null,
          peak_g: 1.02,
          min_g: 0.98,
          rms_g: 1.0,
          sample_count: 1500,
        },
      ]);
    });

    it('opens no transaction for an empty batch', async () => {
      const { db, store } = await openFake();
      db.statements.length = 0;
      await store.append([]);
      expect(db.statements).toEqual([]);
    });

    it('rolls the whole batch back and throws ReadingStoreError when one row fails', async () => {
      const { db, store } = await openFake();
      await store.append([hr(-60_000, 70)]);
      db.failNext('runAsync', new Error('database or disk is full'));
      // The first INSERT of this batch fails; the fake's `failNext` fires on the first `runAsync`.
      await expect(store.append([hr(0, 72), hr(60_000, 73)])).rejects.toMatchObject({
        name: 'ReadingStoreError',
        message: expect.stringContaining('database or disk is full'),
      });
      expect(db.statements.at(-1)).toBe('ROLLBACK');
      await expect(store.count()).resolves.toBe(1);
    });
  });

  describe('readSince', () => {
    it('reads back a row into the same SensorReading shape it was written from', async () => {
      const { store } = await openFake();
      const full = {
        source: 'health_connect' as const,
        timestamp: T0,
        hr: 72,
        spo2: 97,
        skinTempC: 33.4,
        motionSummary: { peakG: 2.4, minG: 0.1, rmsG: 1.1, sampleCount: 1234 },
      };
      await store.append([full]);
      await expect(store.readSince(T0)).resolves.toEqual([full]);
    });

    it('omits the optional fields that were NULL, rather than returning them as undefined keys', async () => {
      // `toEqual` treats `{ hr: undefined }` and `{}` alike; the engine does not (`'hr' in r`
      // style checks and JSON round-trips would differ), so this is pinned with `toStrictEqual`.
      const { store } = await openFake();
      await store.append([hr(0, 72)]);
      const [back] = await store.readSince(T0);
      expect(back).toStrictEqual({ source: 'health_connect', timestamp: T0, hr: 72 });
    });

    it('wraps a read failure', async () => {
      const { db, store } = await openFake();
      db.failNext('getAllAsync');
      await expect(store.readSince(0)).rejects.toBeInstanceOf(ReadingStoreError);
    });
  });

  describe('prune / clear / count', () => {
    it('wraps a prune failure', async () => {
      const { db, store } = await openFake();
      db.failNext('runAsync');
      await expect(store.prune(T0)).rejects.toBeInstanceOf(ReadingStoreError);
    });

    it('wraps a clear failure', async () => {
      const { db, store } = await openFake();
      db.failNext('runAsync');
      await expect(store.clear()).rejects.toBeInstanceOf(ReadingStoreError);
    });

    it('wraps a count failure', async () => {
      const { db, store } = await openFake();
      db.failNext('getFirstAsync');
      await expect(store.count()).rejects.toBeInstanceOf(ReadingStoreError);
    });

    it('names the failed operation in the error message', async () => {
      const { db, store } = await openFake();
      db.failNext('runAsync', new Error('locked'));
      await expect(store.prune(T0)).rejects.toThrow('Reading store prune failed: locked');
    });
  });

  it('is constructible over an already-migrated database', async () => {
    // The provider opens through `openSqliteReadingStore`; the constructor is exposed so a
    // test (or a future migration tool) can wrap a database it already holds.
    const db = new FakeDatabase();
    await openFake(db);
    const store = new SqliteReadingStore(db);
    await store.append([hr(0, 1)]);
    await expect(store.count()).resolves.toBe(1);
  });
});
