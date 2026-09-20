/**
 * `ReadingStoreProvider`: one store for the whole app, SQLite when it opens, memory when it
 * does not — and never a screen that silently reads no store at all.
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { MemoryReadingStore } from '@/store/memory';
import { ReadingStoreProvider, useReadingStore } from '@/store/provider';
import { openSqliteReadingStore, SqliteReadingStore } from '@/store/sqlite';
import { ReadingStoreError } from '@/store/types';

import { FakeDatabase } from './fake-database';

jest.mock('@/store/sqlite', () => ({
  ...jest.requireActual('@/store/sqlite'),
  openSqliteReadingStore: jest.fn(),
}));

const open = jest.mocked(openSqliteReadingStore);

beforeEach(() => {
  open.mockReset();
});

describe('useReadingStore', () => {
  it('throws outside a ReadingStoreProvider', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(renderHook(() => useReadingStore())).rejects.toThrow(
      /inside a <ReadingStoreProvider>/,
    );
    spy.mockRestore();
  });

  it('exposes the SQLite store once it opens', async () => {
    const sqlite = new SqliteReadingStore(new FakeDatabase());
    let resolve!: (store: SqliteReadingStore) => void;
    open.mockReturnValue(new Promise((res) => { resolve = res; }));
    const { result } = await renderHook(() => useReadingStore(), { wrapper: ReadingStoreProvider });

    // Not ready while the open is in flight, and the placeholder is a memory store.
    expect(result.current.ready).toBe(false);
    expect(result.current.backend).toBe('memory');
    resolve(sqlite);
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.backend).toBe('sqlite');
    expect(result.current.store).toBe(sqlite);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('falls back to a memory store, ready, when SQLite fails to open', async () => {
    open.mockRejectedValue(new ReadingStoreError('open', new Error('no native module')));
    const { result } = await renderHook(() => useReadingStore(), { wrapper: ReadingStoreProvider });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.backend).toBe('memory');
    expect(result.current.store).toBeInstanceOf(MemoryReadingStore);
    await result.current.store.append([{ source: 'health_connect', timestamp: 1, hr: 60 }]);
    await expect(result.current.store.count()).resolves.toBe(1);
  });

  it('falls back under the global Jest shim, where expo-sqlite is inert, without logging', async () => {
    // The real opener rejects under Jest (`jest/setup-after-env.js`). No `console.*` on the
    // fallback path: a silent memory store is the documented behaviour, not a fault to shout.
    open.mockImplementation(jest.requireActual('@/store/sqlite').openSqliteReadingStore);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warns = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = await renderHook(() => useReadingStore(), { wrapper: ReadingStoreProvider });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.backend).toBe('memory');
    expect(errors).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    errors.mockRestore();
    warns.mockRestore();
  });

  it('serves an injected store immediately, for tests and screens that need a known backend', async () => {
    const injected = new MemoryReadingStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ReadingStoreProvider store={injected}>{children}</ReadingStoreProvider>
    );
    const { result } = await renderHook(() => useReadingStore(), { wrapper });
    expect(result.current).toEqual({ store: injected, backend: 'memory', ready: true });
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps one store identity across re-renders', async () => {
    open.mockResolvedValue(new SqliteReadingStore(new FakeDatabase()));
    const { result, rerender } = await renderHook(() => useReadingStore(), {
      wrapper: ReadingStoreProvider,
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const first = result.current.store;
    await rerender(undefined);
    expect(result.current.store).toBe(first);
  });

  it('ignores an open that resolves after unmount', async () => {
    let resolve!: (store: SqliteReadingStore) => void;
    open.mockReturnValue(new Promise((res) => { resolve = res; }));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = await renderHook(() => useReadingStore(), { wrapper: ReadingStoreProvider });
    await unmount();
    resolve(new SqliteReadingStore(new FakeDatabase()));
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
