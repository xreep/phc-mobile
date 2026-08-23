/**
 * End-to-end check that the Dashboard renders *computed* risk from the *live* environment.
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
 *
 * The live environment feed adds a second version of the same question. The heat card used to
 * be driven by a constant, and swapping in a network call is exactly the kind of change that
 * can leave a screen looking correct while quietly reading the old source. Two of the tests
 * below therefore vary the *fetched* observation and assert the card follows it — cool, clean
 * air must turn the red card green — because a card that cannot change is indistinguishable
 * from one that is right.
 *
 * The vitals row (PRD §7.2.1 extension) needs the same treatment and cannot get it from the
 * weather, which it does not read. Its only input is the reading buffer, so `buildMockReadings`
 * is mocked through to the real implementation by default and overridden in one test, which is
 * what makes "+16%" — a string composed inside `risk/baseline.ts` from a mean the fixture never
 * states — reachable on the real screen. The shipped window is deliberately quiet, so without
 * that override every row assertion here would pass against a hardcoded "In line".
 */

import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from '@/app/index';
import { buildMockReadings } from '@/constants/mock-sensor-window';
import { fetchLiveEnvironment, readCachedEnvironment, type LiveEnvironment } from '@/environment';
import { liveEnvironment } from '@/environment/__tests__/fixtures';
import { EnvironmentProvider } from '@/environment/provider';
import { SettingsProvider } from '@/settings/provider';

// Hoisted above the imports, so the two entry points are already the mocked copies while the
// real feed hook, provider, engine, and screen all stay in the path. This is the whole app
// below the network boundary, which is the point of the file.
jest.mock('@/environment', () => ({
  ...jest.requireActual('@/environment'),
  fetchLiveEnvironment: jest.fn(),
  readCachedEnvironment: jest.fn(),
}));

// `buildEnvironmentSnapshot` stays real — only the reading buffer is swappable, and it defaults
// to the real fixture in the file-level `beforeEach` below.
jest.mock('@/constants/mock-sensor-window', () => ({
  ...jest.requireActual('@/constants/mock-sensor-window'),
  buildMockReadings: jest.fn(),
}));

const actualWindow =
  jest.requireActual<typeof import('@/constants/mock-sensor-window')>(
    '@/constants/mock-sensor-window',
  );

const mockedFetch = fetchLiveEnvironment as jest.MockedFunction<typeof fetchLiveEnvironment>;
const mockedRead = readCachedEnvironment as jest.MockedFunction<typeof readCachedEnvironment>;
const mockedReadings = buildMockReadings as jest.MockedFunction<typeof buildMockReadings>;

/** Runs before every `describe`'s own hook, so the default really is the shipped window. */
beforeEach(() => {
  mockedReadings.mockReset();
  mockedReadings.mockImplementation(actualWindow.buildMockReadings);
});

/** Frozen instant, so the derived "updated" line is exact. Matches the fixture's anchor. */
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
      <EnvironmentProvider>
        {/* The SOS module reads its contact list and consent flag from here (PRD §7.2.5/§7.2.6).
            Storage is the AsyncStorage jest mock, so every test in this file starts from the
            documented defaults: no contacts, SOS opt-in on. */}
        <SettingsProvider>
          <HomeScreen />
        </SettingsProvider>
      </EnvironmentProvider>
    </SafeAreaProvider>,
  );
}

describe('Home dashboard', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockedFetch.mockReset();
    mockedRead.mockReset();
    mockedRead.mockResolvedValue(null);
    // 38 °C at 62 % RH with an EPA AQI of 168 — the conditions the retired `ENVIRONMENT`
    // constant described, now arriving the way the app really gets them.
    mockedFetch.mockResolvedValue(liveEnvironment());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders one card per rule-engine category', async () => {
    const { getByText } = await renderHome();

    // The screen maps over `assessment.categories`, so the last two arrive automatically —
    // which is exactly why they are named here. `Dehydration` and `Fatigue` are the PRD
    // §7.2.4 advisory extensions; without this list a category could be dropped from
    // `CATEGORY_ORDER` and the UI would silently render five cards.
    for (const label of [
      'Heat Stress',
      'Respiratory',
      'Cardiovascular',
      'Fall Detection',
      'Dehydration',
      'Fatigue',
    ]) {
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
    // The other five → green. Two of those are the §7.2.4 advisories, which stay green in
    // extreme heat because each is a conjunction: the heart rate has neither drifted off the
    // window's baseline nor stayed elevated through a long still stretch.
    expect(getAllByText('Normal')).toHaveLength(5);
  });

  it('shows the newest reading’s vitals', async () => {
    const { getByText } = await renderHome();

    expect(getByText('78')).toBeTruthy();
    expect(getByText('97')).toBeTruthy();
    expect(getByText('36.8')).toBeTruthy();
  });

  it('shows each vital against its own rolling average over the same window', async () => {
    const { getAllByText, getByText } = await renderHome();

    // One delta line per vital, and one sentence under the row. The horizon in that sentence is
    // derived from `window.ms` inside the engine — nothing on the screen or in the fixture
    // spells out "10-minute" — which is what makes it a wiring assertion rather than a
    // spelling one.
    expect(getAllByText('In line')).toHaveLength(3);
    expect(getByText('In line with your 10-minute average.')).toBeTruthy();
  });

  it('reports a deviation on the screen when the readings actually move', async () => {
    // The shipped window is quiet by design, so this is the only place the Dashboard can be
    // shown to report a deviation at all. The same 20 bpm the fixture tests use, confined to the
    // newest four minutes: `risk/baseline.ts` turns it into 16 % against an 84.4 bpm mean, and
    // neither number exists anywhere in the app's source.
    mockedReadings.mockImplementation((now) =>
      actualWindow.buildMockReadings(now).map((sample) => ({
        ...sample,
        hr: sample.timestamp > now - 4 * 60_000 ? (sample.hr as number) + 20 : sample.hr,
      })),
    );

    const { getByText } = await renderHome();

    expect(getByText('98')).toBeTruthy();
    expect(getByText('+16%')).toBeTruthy();
    expect(getByText('Heart rate is 16% above your 10-minute average.')).toBeTruthy();
  });

  it('derives the freshness line from the reading it evaluated', async () => {
    const { getByText } = await renderHome();

    expect(getByText('Updated 30s ago · Simulated data')).toBeTruthy();
  });

  it('offers SOS and says it has nowhere to send until a contact is added', async () => {
    const { getByText } = await renderHome();

    expect(getByText('Emergency SOS')).toBeTruthy();
    // The button is wired now (PRD §7.2.5), and the contact list starts empty on purpose —
    // seeding demo numbers beside a live send path would text a stranger on the first press.
    // Saying so on the button is the difference between an honest default and a silent one.
    expect(
      getByText('Add an emergency contact in Settings so this has somewhere to send.'),
    ).toBeTruthy();
  });
});

describe('the heat card follows the fetched observation', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockedFetch.mockReset();
    mockedRead.mockReset();
    mockedRead.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('goes green on a mild day, so the red card is a real positive', async () => {
    // 18 °C at 55 % RH. If the card were still reading a constant — or a leftover mock —
    // it would stay red here and no other test in the project would notice.
    mockedFetch.mockResolvedValue(liveEnvironment({ tempC: 18, humidity: 55, aqi: 32 }));

    const { getByText, getAllByText, queryByText } = await renderHome();

    expect(getByText('Heat conditions are comfortable.')).toBeTruthy();
    expect(getAllByText('Normal')).toHaveLength(6);
    expect(queryByText('Alert')).toBeNull();
    expect(
      queryByText('Extreme heat danger — get indoors or into shade and cool down now.'),
    ).toBeNull();
  });

  it('says it has no weather yet rather than reporting comfort', async () => {
    // The first render happens before the network answers, and this is the state a user on
    // a slow connection actually sees. Green is the only level available for an unassessed
    // category, so the metric and guidance carry the whole difference.
    mockedFetch.mockReturnValue(new Promise<LiveEnvironment>(() => {}));

    const { getByText, queryByText } = await renderHome();

    expect(getByText('No local weather data yet.')).toBeTruthy();
    expect(getByText('Heat index —')).toBeTruthy();
    expect(queryByText('Heat conditions are comfortable.')).toBeNull();
  });

  it('renders the reading saved offline when the network call fails', async () => {
    mockedRead.mockResolvedValue(liveEnvironment());
    mockedFetch.mockRejectedValue(new Error('offline'));

    const { getByText } = await renderHome();

    // The cache exists so the Dashboard keeps assessing heat risk on a train, and a card
    // built from the last known good observation is the whole return on it.
    expect(getByText('Heat index 56°C')).toBeTruthy();
    expect(
      getByText('Extreme heat danger — get indoors or into shade and cool down now.'),
    ).toBeTruthy();
  });
});
