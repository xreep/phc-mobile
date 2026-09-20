/**
 * The sensor context, and its one hard rule: a screen that reads the feed outside the
 * provider fails at first render, never silently renders an empty vitals row.
 *
 * Since M6 the provider also waits for the reading store: the feed must not start on the
 * placeholder store and lose its first poll when SQLite takes over.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { checkHealthConnect } from '@/sensors/health-connect';
import { SensorProvider, useSensorFeed } from '@/sensors/provider';
import { SettingsProvider } from '@/settings/provider';
import { SETTINGS_KEY } from '@/settings/store';
import { MemoryReadingStore } from '@/store/memory';
import { ReadingStoreProvider } from '@/store/provider';
import { openSqliteReadingStore, SqliteReadingStore } from '@/store/sqlite';

import { FakeDatabase } from '../../store/__tests__/fake-database';

jest.mock('@/sensors/health-connect', () => ({
  ...jest.requireActual('@/sensors/health-connect'),
  checkHealthConnect: jest.fn(() => Promise.resolve('unavailable')),
}));

jest.mock('@/store/sqlite', () => ({
  ...jest.requireActual('@/store/sqlite'),
  openSqliteReadingStore: jest.fn(),
}));

const check = jest.mocked(checkHealthConnect);
const open = jest.mocked(openSqliteReadingStore);

beforeEach(async () => {
  await AsyncStorage.clear();
  check.mockClear();
  open.mockReset().mockRejectedValue(new Error('no sqlite under test'));
});

describe('useSensorFeed', () => {
  it('throws outside a SensorProvider', async () => {
    // React logs the render failure itself; the assertion is about the throw, not the log.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(renderHook(() => useSensorFeed())).rejects.toThrow(
      /inside a <SensorProvider>/,
    );
    spy.mockRestore();
  });

  it('throws when mounted without a ReadingStoreProvider', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SettingsProvider>
        <SensorProvider>{children}</SensorProvider>
      </SettingsProvider>
    );
    await expect(renderHook(() => useSensorFeed(), { wrapper })).rejects.toThrow(
      /inside a <ReadingStoreProvider>/,
    );
    spy.mockRestore();
  });

  it('is idle under the default (simulated) sensor source', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SettingsProvider>
        <ReadingStoreProvider store={new MemoryReadingStore()}>
          <SensorProvider>{children}</SensorProvider>
        </ReadingStoreProvider>
      </SettingsProvider>
    );
    const { result } = await renderHook(() => useSensorFeed(), { wrapper });
    expect(result.current.status).toBe('idle');
    expect(result.current.readings).toEqual([]);
    expect(result.current.storeFailure).toBeNull();
  });

  it('waits for the store to be ready before starting the Health Connect feed', async () => {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ sensorSource: 'health_connect' }));
    let resolve!: (store: SqliteReadingStore) => void;
    open.mockReturnValue(new Promise((res) => { resolve = res; }));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SettingsProvider>
        <ReadingStoreProvider>
          <SensorProvider>{children}</SensorProvider>
        </ReadingStoreProvider>
      </SettingsProvider>
    );

    const { result } = await renderHook(() => useSensorFeed(), { wrapper });
    // Settings have loaded (health_connect) but the store has not: still idle, no SDK call.
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(result.current.status).toBe('idle');
    expect(check).not.toHaveBeenCalled();

    resolve(new SqliteReadingStore(new FakeDatabase()));
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toBe('unavailable'));
  });
});
