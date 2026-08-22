/**
 * End-to-end check that the Dashboard renders *computed* risk, not constants.
 *
 * The unit tests next to the fixture prove the engine returns the right assessment; this
 * proves that assessment reaches the screen. Those are different failures — the cards
 * could equally well have been left wired to a hardcoded array, and every engine test
 * would still pass.
 *
 * So the assertions here are deliberately about strings that exist *nowhere* in the
 * source: the guidance ladder's Extreme Danger rung and the rounded heat-index metric are
 * built inside `rules/heat.ts` at evaluation time, and the "30s ago" freshness is derived
 * from reading timestamps. If any of it were re-hardcoded, these would be the tests that
 * kept passing only if someone copied the engine's exact output into the UI by hand.
 */

import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from '@/app/index';

/** Frozen instant, so the derived "updated" line is exact. */
const NOW = 1_766_000_000_000;

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

/**
 * `render` is **async** in react-native-testing-library v14 — the React 19 rewrite onto
 * the `test-renderer` package returns a promise, and the queries (and the module-level
 * `screen`) only exist once it resolves. Forgetting the `await` does not throw; it yields
 * a promise whose `getByText` is `undefined`, so every assertion fails on a misleading
 * "not a function".
 */
function renderHome() {
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <HomeScreen />
    </SafeAreaProvider>,
  );
}

describe('Home dashboard', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders one card per rule-engine category', async () => {
    const { getByText } = await renderHome();

    for (const label of ['Heat Stress', 'Respiratory', 'Cardiovascular', 'Fall Detection']) {
      expect(getByText(label)).toBeTruthy();
    }
  });

  it('shows the engine’s own guidance and metric for the flagged category', async () => {
    const { getByText } = await renderHome();

    // Composed in `rules/heat.ts`; this string is not present anywhere else in the app.
    expect(
      getByText('Extreme heat danger — get indoors or into shade and cool down now.'),
    ).toBeTruthy();
    expect(getByText('Heat index 56°C')).toBeTruthy();
  });

  it('shows the traffic-light status word the computed level maps to', async () => {
    const { getByText, getAllByText } = await renderHome();

    expect(getByText('Alert')).toBeTruthy(); // heat → red
    expect(getAllByText('Normal')).toHaveLength(3); // the other three → green
  });

  it('shows the newest reading’s vitals', async () => {
    const { getByText } = await renderHome();

    expect(getByText('78')).toBeTruthy();
    expect(getByText('97')).toBeTruthy();
    expect(getByText('36.8')).toBeTruthy();
  });

  it('derives the freshness line from the reading it evaluated', async () => {
    const { getByText } = await renderHome();

    expect(getByText('Updated 30s ago · Simulated data')).toBeTruthy();
  });

  it('still offers SOS, which remains a later phase', async () => {
    const { getByText } = await renderHome();

    // Present but inert: PRD §7.2.5 owns the cancel window, GPS, and messaging.
    expect(getByText('Emergency SOS')).toBeTruthy();
  });
});
