/**
 * The Trends screen shows sample data and says so.
 *
 * The screen renders fixed example curves from the `TRENDS` constant — PRD §7.2.1 vitals
 * ingestion has not landed, so nothing is recorded or stored over time. The screen used to
 * subtitle itself "Vitals history from on-device storage", which asserted a persistence layer
 * that does not exist. This file pins the two things that keep that from coming back: the
 * honest disclosure is present, and the old storage claim is absent. Layout is not the point —
 * one card per series is enough to prove the sample data reaches the screen.
 */

import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import TrendsScreen from '@/app/trends';
import { TRENDS } from '@/constants/health-data';

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function renderTrends() {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <TrendsScreen />
    </SafeAreaProvider>,
  );
}

describe('Trends screen', () => {
  it('discloses that the data is sample data, not a stored history', async () => {
    const { getByText } = await renderTrends();

    expect(getByText('Example data — not a recorded history')).toBeTruthy();
    expect(
      getByText(
        'These curves are fixed sample series to show how trends will look. This build does not yet record or store your vitals over time, so nothing here reflects your own readings.',
      ),
    ).toBeTruthy();
  });

  it('no longer claims the vitals come from on-device storage', async () => {
    const { queryByText } = await renderTrends();

    // The exact retired string, and the substring that carried the false persistence claim.
    expect(queryByText('Vitals history from on-device storage')).toBeNull();
    expect(queryByText(/on-device storage/)).toBeNull();
  });

  it('renders a card for each example series in the default 24-hour range', async () => {
    const { getByText } = await renderTrends();

    for (const series of TRENDS['24h']) {
      expect(getByText(series.label)).toBeTruthy();
    }
  });
});
