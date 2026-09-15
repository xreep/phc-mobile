/**
 * The sensor context, and its one hard rule: a screen that reads the feed outside the
 * provider fails at first render, never silently renders an empty vitals row.
 */

import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { SensorProvider, useSensorFeed } from '@/sensors/provider';
import { SettingsProvider } from '@/settings/provider';

describe('useSensorFeed', () => {
  it('throws outside a SensorProvider', async () => {
    // React logs the render failure itself; the assertion is about the throw, not the log.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(renderHook(() => useSensorFeed())).rejects.toThrow(
      /inside a <SensorProvider>/,
    );
    spy.mockRestore();
  });

  it('is idle under the default (simulated) sensor source', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SettingsProvider>
        <SensorProvider>{children}</SensorProvider>
      </SettingsProvider>
    );
    const { result } = await renderHook(() => useSensorFeed(), { wrapper });
    expect(result.current.status).toBe('idle');
    expect(result.current.readings).toEqual([]);
  });
});
