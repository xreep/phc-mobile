/**
 * The persistent reading store (M6) — public surface.
 *
 * Local-only by construction: see `types.ts` for the two rules (nothing leaves the device;
 * simulated readings are never written) and `docs/features/reading-store.md`.
 */

export { MemoryReadingStore } from './memory';
export { ReadingStoreProvider, useReadingStore } from './provider';
export type { ReadingStoreContextValue, ReadingStoreProviderProps } from './provider';
export { DATABASE_NAME, openSqliteReadingStore, SCHEMA_VERSION, SqliteReadingStore } from './sqlite';
export { HISTORY_RETAIN_MS, ReadingStoreError } from './types';
export type { ReadingStore, ReadingStoreBackend } from './types';
