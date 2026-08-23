/**
 * One environment feed for the whole app.
 *
 * ## Why this is a context rather than a hook each screen calls
 * Two screens consume this data: the Environment screen renders it, and the Dashboard
 * feeds it to the risk engine. Expo Router keeps both mounted at once, so a bare
 * `useEnvironment()` in each would create two independent feeds — two location fixes, two
 * pairs of API calls, two 30-minute timers. The call volume is affordable, but the
 * divergence is not: the two screens would be showing observations fetched at different
 * instants, so the Environment screen could read 34 °C while the Dashboard's heat card was
 * computed from 36 °C. A user comparing the two would be looking at a contradiction with
 * no way to tell which was current.
 *
 * Hoisting the feed to a single provider makes that class of disagreement structurally
 * impossible rather than merely unlikely.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { useEnvironment, type EnvironmentFeed } from '@/hooks/use-environment';

const EnvironmentContext = createContext<EnvironmentFeed | null>(null);

export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const feed = useEnvironment();
  return <EnvironmentContext.Provider value={feed}>{children}</EnvironmentContext.Provider>;
}

/**
 * The shared feed.
 *
 * Throws when no provider is mounted, deliberately. The alternative — returning an inert
 * "nothing loaded" default — would render a screen full of em dashes and a Dashboard whose
 * heat card silently ignored the weather, with nothing anywhere reporting a fault. That is
 * the exact failure shape this project keeps having to dig out, so a missing provider fails
 * loudly at the first render instead.
 */
export function useEnvironmentFeed(): EnvironmentFeed {
  const feed = useContext(EnvironmentContext);
  if (feed === null) {
    throw new Error('useEnvironmentFeed must be used inside an <EnvironmentProvider>.');
  }
  return feed;
}
