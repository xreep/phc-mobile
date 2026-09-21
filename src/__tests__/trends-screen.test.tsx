/**
 * The Trends screen renders real history from the persisted reading store, not sample data.
 *
 * Three things matter, and each is a different way the old hardcoded `TRENDS` constant could
 * still be lurking underneath an honest-looking screen:
 *
 * 1. **The simulated source shows the disclosure, never a chart** — even when the store still
 *    holds real history from an earlier Health Connect session (`src/store/types.ts`'s "simulated
 *    readings are never written" rule means that history is real but stale-by-source, and this
 *    build does not try to disambiguate "current" from "leftover" for the reader).
 * 2. **A live source renders numbers the aggregator computed**, not anything hardcoded in
 *    `trends.tsx` or `constants/health-data.ts`. The assertions below use bpm values chosen
 *    specifically because they exist nowhere in source — 133 and 97 are not in `TrendCard`,
 *    `formatValue`, or any fixture this file shares with the component. `ble_esp32` is used as
 *    the "live" source rather than `health_connect`, so this suite exercises `status: 'ready'`
 *    without also tripping the memory-backend `'unavailable'` rule that a real device only hits
 *    when SQLite fails to open (`use-trends.test.ts` covers that rule directly).
 * 3. **The range toggle re-aggregates** rather than swapping between two pre-baked arrays: a
 *    reading placed only inside the 7-day window must be invisible at 24h and appear at 7d.
 *
 * ## Every case leads with `findByText`, never a bare `getByText` right after `render`
 * `useTrends`'s data effect resolves `store.readSince(...)` — a real `Promise`, even against the
 * in-memory store — after `render`'s own await returns. On this suite's first test that gap
 * lands the effect's `setLoading`/`setSeries` calls outside any `act()`, and React warns
 * ("not configured to support act(...)") even though the assertions still pass — a suite that is
 * green by timing rather than by waiting for the real settle point. `findByText` polls (wrapped
 * in `act`) instead of asserting the instant `render` returns, which is what closes the gap. The
 * `console.error` guard below turns a regression back into a hard failure instead of quiet noise.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import TrendsScreen from '@/app/trends';
import { SensorProvider } from '@/sensors/provider';
import { SettingsProvider } from '@/settings/provider';
import { SETTINGS_KEY } from '@/settings/store';
import { MemoryReadingStore } from '@/store';
import { ReadingStoreProvider } from '@/store/provider';

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const NOW = 1_766_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function renderTrends(store: MemoryReadingStore) {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <SettingsProvider>
        <ReadingStoreProvider store={store}>
          <SensorProvider>
            <TrendsScreen />
          </SensorProvider>
        </ReadingStoreProvider>
      </SettingsProvider>
    </SafeAreaProvider>,
  );
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  // Suppresses the noise and records it, so a regression to an un-`act`-wrapped state update
  // fails the test instead of scrolling past silently.
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  expect(consoleError).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  await AsyncStorage.clear();
});

describe('Trends screen', () => {
  describe('simulated source (the default)', () => {
    it('shows the disclosure and no chart, even when the store holds real history', async () => {
      const store = new MemoryReadingStore();
      await store.append([{ source: 'health_connect', timestamp: NOW - HOUR, hr: 61 }]);

      const { findByText, queryByText } = await renderTrends(store);

      expect(await findByText('Trends need recorded readings')).toBeTruthy();
      expect(
        await findByText(
          'Switch Sensor source to Android Health Connect in Settings. Simulated readings are never stored.',
        ),
      ).toBeTruthy();
      expect(queryByText('Heart Rate')).toBeNull();
      expect(queryByText('61 bpm')).toBeNull();
    });
  });

  describe('a live source with recorded history', () => {
    beforeEach(async () => {
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({ sensorSource: 'ble_esp32' }));
    });

    it('renders numbers the aggregator computed, not anything hardcoded', async () => {
      const store = new MemoryReadingStore();
      // Three distinct values, oldest → newest, so `current` (newest), `max`, `min` and `avg`
      // each land on a different number and this test cannot pass by accident.
      await store.append([
        { source: 'health_connect', timestamp: NOW - 3 * HOUR, hr: 61 }, // min
        { source: 'health_connect', timestamp: NOW - 2 * HOUR, hr: 200 }, // max, but not newest
        { source: 'health_connect', timestamp: NOW - HOUR, hr: 133 }, // newest → current
      ]);

      const { findByText, getByText } = await renderTrends(store);

      expect(await findByText('Heart Rate')).toBeTruthy();
      // `current` is the newest sample, not the largest — composed by `summarizeTrend`, printed
      // nowhere in source.
      expect(getByText('133 bpm')).toBeTruthy();
      expect(getByText('61 bpm')).toBeTruthy(); // Min
      expect(getByText('200 bpm')).toBeTruthy(); // Max
      // avg = (61 + 200 + 133) / 3 = 131.33…, rounded — also composed, not a literal anywhere
      // in this build.
      expect(getByText('131 bpm')).toBeTruthy();
    });

    it('shows the honest empty state when nothing falls in the range', async () => {
      const store = new MemoryReadingStore();

      const { findByText } = await renderTrends(store);

      expect(await findByText('No readings in the last 24 hours yet')).toBeTruthy();
    });

    it('re-aggregates on a range toggle rather than swapping between two fixed arrays', async () => {
      const store = new MemoryReadingStore();
      // Only inside the 7-day window, not the 24-hour one.
      await store.append([{ source: 'health_connect', timestamp: NOW - 3 * DAY, hr: 150 }]);

      const { getByText, findByText, queryByText } = await renderTrends(store);

      expect(await findByText('No readings in the last 24 hours yet')).toBeTruthy();
      expect(queryByText('Heart Rate')).toBeNull();

      await fireEvent.press(getByText('7 days'));

      // `useTrends`'s range-change read is asynchronous; `findByText` polls (wrapped in `act`)
      // rather than asserting immediately after the synchronous press.
      expect(await findByText('Heart Rate')).toBeTruthy();
      expect(queryByText('No readings in the last 24 hours yet')).toBeNull();
    });
  });
});
