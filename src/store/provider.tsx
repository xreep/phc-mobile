/**
 * One reading store for the whole app.
 *
 * Mounted in `_layout.tsx` **above** `SensorProvider`: the sensor hook appends to and reads
 * from this store, and Settings' "Erase my health data" clears it, so both must see the same
 * instance — two stores would let a reading persist in one and be erased from the other.
 *
 * ## Open once, fall back silently
 * SQLite is opened on mount. If that rejects (no native module — Expo Go, Jest — or a broken
 * file), the provider serves a `MemoryReadingStore` instead and says so through `backend`.
 * Nothing is logged: a memory store is the documented degraded mode (the app behaves exactly
 * as it did before persistence existed), not a fault to shout about, and `console.*` in the
 * app's runtime path is against this codebase's conventions.
 *
 * ## `ready`
 * False until the open has settled either way. `SensorProvider` gates the feed on it so the
 * first poll never writes to a placeholder memory store that the SQLite store then replaces —
 * that would lose the warm start the store exists to provide.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { MemoryReadingStore } from './memory';
import { openSqliteReadingStore } from './sqlite';
import type { ReadingStore, ReadingStoreBackend } from './types';

export type ReadingStoreContextValue = {
  readonly store: ReadingStore;
  readonly backend: ReadingStoreBackend;
  /** True once the SQLite open has settled (either way). */
  readonly ready: boolean;
};

const ReadingStoreContext = createContext<ReadingStoreContextValue | null>(null);

export type ReadingStoreProviderProps = {
  readonly children: ReactNode;
  /**
   * Serve this store, ready at once, instead of opening SQLite. For tests (a known memory
   * store) — the app never passes it.
   */
  readonly store?: ReadingStore;
};

type Opened = { readonly store: ReadingStore; readonly backend: ReadingStoreBackend };

export function ReadingStoreProvider({ children, store: injected }: ReadingStoreProviderProps) {
  const [opened, setOpened] = useState<Opened | null>(null);

  useEffect(() => {
    if (injected !== undefined) return;
    let cancelled = false;
    void (async () => {
      let next: Opened;
      try {
        next = { store: await openSqliteReadingStore(), backend: 'sqlite' };
      } catch {
        next = { store: new MemoryReadingStore(), backend: 'memory' };
      }
      if (!cancelled) setOpened(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [injected]);

  const value = useMemo<ReadingStoreContextValue>(() => {
    if (injected !== undefined) return { store: injected, backend: 'memory', ready: true };
    if (opened !== null) return { ...opened, ready: true };
    // Placeholder while the open is in flight. Not `null`: a consumer may already be mounted,
    // and `SensorProvider` waits on `ready` rather than on the store's existence.
    return { store: PENDING, backend: 'memory', ready: false };
  }, [injected, opened]);

  return <ReadingStoreContext.Provider value={value}>{children}</ReadingStoreContext.Provider>;
}

/** Shared inert placeholder for the pre-open render; nothing should write to it (`ready` is false). */
const PENDING: ReadingStore = new MemoryReadingStore();

/**
 * Throws when no provider is mounted, deliberately — an inert default would let a screen
 * "erase" a store nobody writes to, or a hook read an empty history, with no fault anywhere.
 */
export function useReadingStore(): ReadingStoreContextValue {
  const value = useContext(ReadingStoreContext);
  if (value === null) {
    throw new Error('useReadingStore must be used inside a <ReadingStoreProvider>.');
  }
  return value;
}
