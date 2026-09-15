/**
 * Environment screen tests.
 *
 * The screen's whole job is to be honest about data it did not choose, so the assertions are
 * weighted towards what it says when something is *missing* — which, for two network calls on
 * a mobile connection, is the ordinary case rather than the edge one.
 *
 * The load-bearing ones:
 *
 * - **Absent renders as absent.** A missing AQI must reach the screen as an em dash, never as
 *   `0`. Zero is not a neutral placeholder here: it is the reading for pristine air, so the
 *   substitution would turn "we do not know" into active reassurance on a health screen.
 * - **The fallback city is labelled.** When permission is denied the reading is for Chennai
 *   regardless of where the user is standing. Presenting that as their local heat warning is
 *   a misrepresentation with real consequences, so the subtitle is asserted to say both the
 *   city and why it is not the device's.
 * - **The AQI is described as estimated.** EPA's PM breakpoints are defined on 24-hour
 *   averages and this is derived from an instantaneous reading, so the caveat is part of the
 *   number's meaning rather than a footnote.
 *
 * The feed hook is mocked rather than driven: the four states it can be in are already pinned
 * in `use-environment.test.ts`, and reaching them through a real fetch here would test the
 * hook again instead of the rendering.
 *
 * The last describe covers the one section of this screen that is *not* live — the static flood
 * and cyclone guides — and it is here rather than only in a component test because its correctness
 * is a fact about its neighbours: the live cards are two card-lengths above it.
 */

import { fireEvent, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  PREPAREDNESS_ADVISORIES,
  PREPAREDNESS_BADGE,
  PREPAREDNESS_DISCLAIMER,
  PREPAREDNESS_HEADING,
  PREPAREDNESS_INTRO,
} from '@/advisories';
import EnvironmentScreen from '@/app/environment';
import type { LocationFallbackReason } from '@/environment';
import { liveEnvironment } from '@/environment/__tests__/fixtures';
import { useEnvironmentFeed } from '@/environment/provider';
import type { EnvironmentFeed } from '@/hooks/use-environment';

jest.mock('@/environment/provider', () => ({ useEnvironmentFeed: jest.fn() }));

const mockedFeed = useEnvironmentFeed as jest.MockedFunction<typeof useEnvironmentFeed>;

/** Matches the fixture's `FIXTURE_NOW`, so the derived ages are exact. */
const NOW = 1_766_000_000_000;

const INSETS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function feed(overrides: Partial<EnvironmentFeed> = {}): EnvironmentFeed {
  return {
    environment: liveEnvironment(),
    status: 'live',
    failure: null,
    refreshing: false,
    refresh: jest.fn(),
    ...overrides,
  };
}

/** `render` is async in react-native-testing-library v14; without the await the queries are
 *  `undefined` and every assertion fails on a misleading "not a function". */
function renderScreen(overrides: Partial<EnvironmentFeed> = {}) {
  const current = feed(overrides);
  mockedFeed.mockReturnValue(current);
  return render(
    <SafeAreaProvider initialMetrics={INSETS}>
      <EnvironmentScreen />
    </SafeAreaProvider>,
  ).then((rendered) => ({ ...rendered, current }));
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

describe('before there is anything to show', () => {
  it('says what it is doing rather than rendering an empty screen', async () => {
    const { getByText, queryByText } = await renderScreen({
      environment: null,
      status: 'loading',
    });

    expect(getByText('Finding your location…')).toBeTruthy();
    // No cards at all, rather than cards full of placeholders that look like a reading.
    expect(queryByText('Weather')).toBeNull();
    expect(queryByText('Air Quality')).toBeNull();
  });

  it('reports a failure with nothing cached, and does not invent values', async () => {
    const { getByText, queryByText } = await renderScreen({
      environment: null,
      status: 'error',
      failure: { message: 'Weather service is temporarily unavailable.', kind: 'network' },
    });

    expect(getByText('No environment data yet')).toBeTruthy();
    expect(getByText('Environment data unavailable')).toBeTruthy();
    expect(getByText('Weather service is temporarily unavailable.')).toBeTruthy();
    expect(queryByText('Weather')).toBeNull();
  });

  it('falls back to its own wording when the failure carries no message', async () => {
    const { getByText } = await renderScreen({ environment: null, status: 'error', failure: null });
    expect(getByText('Could not load weather or air quality.')).toBeTruthy();
  });
});

describe('a live observation', () => {
  it('shows the measurements it actually fetched', async () => {
    const { getByText } = await renderScreen();

    expect(getByText('38°C')).toBeTruthy();
    expect(getByText('62%')).toBeTruthy();
    // Derived by `computeHeatIndexC(38, 62)` — 56.4 °C — not carried by the provider.
    expect(getByText('56°C')).toBeTruthy();

    for (const label of ['Temperature', 'Humidity', 'Heat index']) {
      expect(getByText(label)).toBeTruthy();
    }
  });

  it('shows the heat band the engine would score off the same numbers', async () => {
    const { getByText } = await renderScreen();
    expect(getByText('Heat: Extreme Danger')).toBeTruthy();
  });

  it('shows the air-quality figures and the EPA scale they are on', async () => {
    const { getByText } = await renderScreen();

    expect(getByText('168')).toBeTruthy();
    expect(getByText('Unhealthy')).toBeTruthy();
    expect(getByText('79.8')).toBeTruthy();
    expect(getByText('90')).toBeTruthy();
    // Naming the scale matters: 168 on the 0–500 EPA scale and 4 on OpenWeatherMap's own
    // 1–5 band describe the same air, and only one of them means anything to a user.
    expect(getByText('AQI (US EPA)')).toBeTruthy();
    expect(getByText('PM2.5 µg/m³')).toBeTruthy();
    expect(getByText('PM10 µg/m³')).toBeTruthy();
  });

  it('calls the index an estimate, because EPA defines it on 24-hour averages', async () => {
    const { getByText } = await renderScreen();
    expect(getByText('Estimated from current PM2.5 and PM10 concentrations.')).toBeTruthy();
  });

  it('says when it only has a coarse band rather than concentrations', async () => {
    const { getByText } = await renderScreen({
      environment: liveEnvironment({ aqi: 250, aqiBasis: 'owm_index', pollutants: null }),
    });

    expect(getByText('Approximate band only — pollutant concentrations were unavailable.')).toBeTruthy();
  });

  it('names the place and how old the reading is', async () => {
    const { getByText } = await renderScreen();
    // The age is the provider's observation time, not when this render happened.
    expect(getByText('Chennai · Updated 12 min ago')).toBeTruthy();
  });
});

describe('values the observation does not carry', () => {
  it('renders a missing AQI as an em dash rather than a zero', async () => {
    const { getByText, getAllByText, queryByText } = await renderScreen({
      environment: liveEnvironment({
        aqi: null,
        aqiCategory: null,
        aqiBasis: null,
        pollutants: null,
      }),
    });

    // `0` would assert pristine air on a screen a user consults before going outside.
    expect(queryByText('0')).toBeNull();
    expect(getAllByText('—')).toHaveLength(3);
    expect(getByText('Air quality data was not available for this location.')).toBeTruthy();
    // The weather half is unaffected: one failed call must not blank the other.
    expect(getByText('38°C')).toBeTruthy();
  });

  it('renders a missing heat index as an em dash and drops the band chip', async () => {
    const { getByText, queryByText } = await renderScreen({
      environment: liveEnvironment({ heatIndexC: null, heatIndexBand: null }),
    });

    expect(getByText('—')).toBeTruthy();
    // A chip with no band would render `undefined` as its label.
    expect(queryByText(/^Heat: /)).toBeNull();
    expect(getByText('38°C')).toBeTruthy();
  });
});

describe('whose location this is', () => {
  it('says the city is a default, and why', async () => {
    const { getByText } = await renderScreen({
      environment: liveEnvironment({
        locationSource: 'fallback',
        locationFallbackReason: 'permission_denied',
      }),
    });

    expect(
      getByText('Chennai (default — location permission not granted) · Updated 12 min ago'),
    ).toBeTruthy();
  });

  it.each([
    ['permission_denied', 'location permission not granted'],
    ['services_disabled', 'location services are off'],
    ['unavailable', 'location unavailable'],
    ['timeout', 'location took too long'],
  ] as [LocationFallbackReason, string][])('explains %s in plain language', async (reason, text) => {
    const { getByText } = await renderScreen({
      environment: liveEnvironment({ locationSource: 'fallback', locationFallbackReason: reason }),
    });

    expect(getByText(new RegExp(`\\(default — ${text}\\)`))).toBeTruthy();
  });

  it('still labels the default when the reason was lost in a cache round trip', async () => {
    // `locationFallbackReason` is optional, and an older cached entry may not carry one.
    // Silently presenting the fallback as a device fix is the one outcome not allowed.
    const { getByText } = await renderScreen({
      environment: liveEnvironment({ locationSource: 'fallback' }),
    });

    expect(getByText(/\(default — location unavailable\)/)).toBeTruthy();
  });

  it('does not label a real device fix', async () => {
    const { queryByText } = await renderScreen();
    expect(queryByText(/default/)).toBeNull();
  });
});

describe('advisories', () => {
  it('shows each one with what produced it', async () => {
    const { getByText } = await renderScreen({
      environment: liveEnvironment({
        advisories: [
          {
            id: 'heat-index',
            source: 'NOAA heat index',
            title: 'Extreme Danger heat — feels like 56°C',
            detail: 'Avoid outdoor exertion. Heat stroke is likely with continued exposure.',
            level: 'red',
          },
        ],
      }),
    });

    expect(getByText('Extreme Danger heat — feels like 56°C')).toBeTruthy();
    expect(getByText('Avoid outdoor exertion. Heat stroke is likely with continued exposure.')).toBeTruthy();
    // Provenance on the card, so nothing here reads as a government warning.
    expect(getByText('NOAA heat index')).toBeTruthy();
  });

  it('says so explicitly when there are none, so a blank space is not ambiguous', async () => {
    const { getByText } = await renderScreen();

    expect(getByText('No advisories')).toBeTruthy();
    expect(getByText('Heat and air quality are both within ordinary ranges right now.')).toBeTruthy();
  });
});

describe('showing saved data offline', () => {
  it('shows the reading and a note about where it came from', async () => {
    const { getByText } = await renderScreen({
      environment: liveEnvironment({ fetchedAt: NOW - 3 * 60 * 60 * 1000 }),
      status: 'cached',
    });

    expect(getByText('Showing the last saved reading')).toBeTruthy();
    // The saved age is separate from the observation age: they diverge precisely here.
    expect(
      getByText('Could not reach the weather service, so this is the reading saved 3 hr ago.'),
    ).toBeTruthy();
    expect(getByText('38°C')).toBeTruthy();
  });

  it('does not claim live data is saved', async () => {
    const { queryByText } = await renderScreen();
    expect(queryByText('Showing the last saved reading')).toBeNull();
  });
});

/**
 * The static section, in context.
 *
 * This is the half of the E3 check that a component test cannot make. `preparedness-card.test.tsx`
 * proves the card renders its own content correctly; what matters here is the *neighbourhood* —
 * these two cards sit directly beneath the live heat and air-quality cards, and the question is
 * whether a reader could carry the assumption of liveness across that boundary. So the assertions
 * below are comparative: the live advisory card has a level chip and a named provenance, this one
 * has a neutral badge and a disclaimer, and the two never swap.
 */
describe('the static preparedness section', () => {
  const LIVE_ADVISORY = {
    id: 'heat-index',
    source: 'NOAA heat index',
    title: 'Extreme Danger heat — feels like 56°C',
    detail: 'Avoid outdoor exertion. Heat stroke is likely with continued exposure.',
    level: 'red' as const,
  };

  it('renders both hazards beneath the live cards, under its own heading', async () => {
    const { getByText } = await renderScreen();

    expect(getByText(PREPAREDNESS_HEADING)).toBeTruthy();
    expect(getByText(PREPAREDNESS_INTRO)).toBeTruthy();
    for (const advisory of PREPAREDNESS_ADVISORIES) {
      expect(getByText(advisory.title)).toBeTruthy();
    }
    // The live cards are still the screen's primary content, not displaced by the static text.
    expect(getByText('Weather')).toBeTruthy();
    expect(getByText('Air Quality')).toBeTruthy();
  });

  it('labels every static card as not based on live conditions', async () => {
    const { getAllByText } = await renderScreen();

    // One per hazard. `getAllByText` with a length assertion rather than `getByText`, which would
    // throw on the second match and hide the fact that both cards carry it.
    expect(getAllByText(PREPAREDNESS_DISCLAIMER)).toHaveLength(PREPAREDNESS_ADVISORIES.length);
    expect(getAllByText(PREPAREDNESS_BADGE)).toHaveLength(PREPAREDNESS_ADVISORIES.length);
  });

  it('is still there when there is no live data at all, which is when it matters most', async () => {
    // The reason it renders outside the `environment === null` guard: a flood knocks the towers
    // down, and guidance gated behind a successful fetch is absent exactly then.
    const { getByText, queryByText } = await renderScreen({ environment: null, status: 'error' });

    expect(getByText(PREPAREDNESS_HEADING)).toBeTruthy();
    expect(getByText('Flood')).toBeTruthy();
    expect(getByText('Cyclone')).toBeTruthy();
    // And the live half is genuinely absent, so this is not passing because everything renders.
    expect(queryByText('Weather')).toBeNull();
    expect(queryByText('Air Quality')).toBeNull();
  });

  it('keeps the live card and the static card visibly different kinds of thing', async () => {
    const { getByText, queryAllByText } = await renderScreen({
      environment: liveEnvironment({ advisories: [LIVE_ADVISORY] }),
    });

    // The live advisory names what produced it and carries a red level chip.
    expect(getByText(LIVE_ADVISORY.title)).toBeTruthy();
    expect(getByText('NOAA heat index')).toBeTruthy();

    // The static cards carry neither: no provenance to name, and no measurement to level. If a
    // future edit gave them a source or a level chip, one of these two counts would change.
    expect(queryAllByText(PREPAREDNESS_BADGE)).toHaveLength(2);
    expect(queryAllByText(PREPAREDNESS_DISCLAIMER)).toHaveLength(2);
    // `RiskCard`'s status vocabulary must not appear anywhere on this screen — the live cards use
    // band labels ("Extreme Danger", "Unhealthy"), and the static cards use no verdict at all.
    for (const word of ['Normal', 'Caution', 'Alert']) {
      expect(queryAllByText(word)).toHaveLength(0);
    }
  });

  it('opens one hazard without opening the other', async () => {
    const screen = await renderScreen();

    // Awaited: `fireEvent` is async in react-native-testing-library v14, and this press causes a
    // state update. The refresh test below gets away without it because it only asserts a mock
    // call, not a re-render.
    await fireEvent.press(screen.getByLabelText('Show flood advisory steps'));

    expect(screen.getByText('Drinking water and food')).toBeTruthy();
    // The cyclone card has its own state; a shared toggle would expand both.
    expect(screen.queryByText('Before the storm')).toBeNull();
    expect(screen.getByLabelText('Show cyclone advisory steps')).toBeTruthy();
  });
});

describe('the on-demand refresh', () => {
  it('offers a labelled control and asks the feed for new data', async () => {
    const { getByLabelText, current } = await renderScreen();

    const button = getByLabelText('Refresh environment data');
    fireEvent.press(button);

    expect(current.refresh).toHaveBeenCalledTimes(1);
  });

  it('reports itself busy rather than looking unresponsive', async () => {
    const { getByLabelText, getByText, queryByText } = await renderScreen({ refreshing: true });

    expect(getByText('Refreshing…')).toBeTruthy();
    expect(queryByText('Refresh')).toBeNull();
    // Announced to assistive technology as well as dimmed, since the visual cue is opacity.
    expect(getByLabelText('Refresh environment data').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});
