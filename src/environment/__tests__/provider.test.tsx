/**
 * Shared-feed tests.
 *
 * Only two properties matter here, and both are about what happens when this module is
 * bypassed rather than about what it renders:
 *
 * 1. **One feed, not one per screen.** Expo Router keeps the Dashboard and the Environment
 *    screen mounted simultaneously. Two independent `useEnvironment()` calls would each fetch,
 *    and the two screens would then be describing observations taken at different instants —
 *    34 °C on one and 36 °C on the other, with nothing to say which is current. The assertion
 *    is that two consumers cost one fetch and see byte-identical data.
 * 2. **A missing provider is loud.** The tempting alternative — an inert default feed — would
 *    render em dashes and a heat card that quietly ignored the weather, which is precisely the
 *    silent-degradation shape this project keeps having to dig back out.
 */

import { render, renderHook } from '@testing-library/react-native';

import { fetchLiveEnvironment, readCachedEnvironment } from '@/environment';
import { liveEnvironment } from '@/environment/__tests__/fixtures';
import { EnvironmentProvider, useEnvironmentFeed } from '@/environment/provider';
import { ThemedText } from '@/components/themed-text';

// Hoisted above the imports, so the two entry points are already the mocked copies while the
// rest of the module — including the real `useEnvironment` the provider calls — stays intact.
jest.mock('@/environment', () => ({
  ...jest.requireActual('@/environment'),
  fetchLiveEnvironment: jest.fn(),
  readCachedEnvironment: jest.fn(),
}));

const mockedFetch = fetchLiveEnvironment as jest.MockedFunction<typeof fetchLiveEnvironment>;
const mockedRead = readCachedEnvironment as jest.MockedFunction<typeof readCachedEnvironment>;

const NOW = 1_766_000_000_000;

/** Renders whatever the shared feed currently holds, so two of these can be compared. */
function Consumer({ testID }: { testID: string }) {
  const { environment, status } = useEnvironmentFeed();
  return (
    <ThemedText testID={testID}>{`${status}:${environment?.location ?? 'none'}:${
      environment?.tempC ?? 'none'
    }`}</ThemedText>
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockedFetch.mockReset();
  mockedRead.mockReset();
  mockedRead.mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('EnvironmentProvider', () => {
  it('serves two screens from a single fetch', async () => {
    mockedFetch.mockResolvedValue(liveEnvironment({ location: 'Chennai', tempC: 38 }));

    const { getByTestId } = await render(
      <EnvironmentProvider>
        <Consumer testID="dashboard" />
        <Consumer testID="environment" />
      </EnvironmentProvider>,
    );

    // One location fix and one pair of API calls for the whole app, not one per screen.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(getByTestId('dashboard').props.children).toBe('live:Chennai:38');
    // Identical strings, so neither screen can be describing a different instant's weather.
    expect(getByTestId('environment').props.children).toBe(
      getByTestId('dashboard').props.children,
    );
  });
});

describe('useEnvironmentFeed outside a provider', () => {
  it('throws rather than returning an inert feed', async () => {
    // React logs the render failure itself; the assertion is about the throw, not the log.
    jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(renderHook(() => useEnvironmentFeed())).rejects.toThrow(
      'useEnvironmentFeed must be used inside an <EnvironmentProvider>.',
    );
  });
});
