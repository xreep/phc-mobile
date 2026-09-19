/**
 * `useAlerts` tests.
 *
 * The planner (`@/alerts/plan`) and the OS layer (`@/alerts/notify`) are both unit-tested on
 * their own, so this suite is about the wiring: does the hook call the planner exactly when
 * `assessment.evaluatedAt` changes, and does it ever call `deliverAlert` outside
 * `enabled && live && permission === 'granted'`. Permission itself now comes from
 * `@/alerts/provider`'s `useAlertPermission()` — mocked module-wide here, the same convention
 * `src/hooks/__tests__/use-risk-assessment.test.ts` uses for `useSettings`/`useSensorFeed` — so a
 * test can move the mocked `permission` value between renders and assert this *already-mounted*
 * hook instance reacts, which is the exact bug (`review round 1, CRITICAL #1`) this design fixes:
 * a grant made elsewhere (Settings) must reach an already-mounted Dashboard hook without a
 * remount.
 *
 * As `src/__tests__/settings-screen.test.tsx` documents for `render`, react-native-testing-
 * library v14 makes `renderHook` and `rerender` async too — both are awaited throughout.
 */

import { renderHook } from '@testing-library/react-native';

import { assessment } from '@/alerts/__tests__/fixtures';
import type { AlertIntent } from '@/alerts/plan';
import type { AlertPermission } from '@/alerts/notify';
import { useAlertPermission } from '@/alerts/provider';
import { useAlerts } from '@/hooks/use-alerts';

jest.mock('@/alerts/provider', () => ({ useAlertPermission: jest.fn() }));

const mockedUseAlertPermission = jest.mocked(useAlertPermission);

const T0 = 1_700_000_000_000;

/** Sets what `useAlertPermission()` returns until changed again. `refreshPermission` and
 *  `requestPermission` are no-op stand-ins here — this suite is about the *gate*, not about
 *  who calls them; `src/alerts/__tests__/provider.test.tsx` covers the provider itself. */
function setMockPermission(permission: AlertPermission) {
  mockedUseAlertPermission.mockReturnValue({
    permission,
    refreshPermission: jest.fn(),
    requestPermission: jest.fn(),
  });
}

function makeCollaborators() {
  const delivered: AlertIntent[] = [];
  return {
    deliverImpl: jest.fn(async (intent: AlertIntent) => {
      delivered.push(intent);
    }),
    delivered,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  setMockPermission('granted');
});

afterEach(() => {
  jest.useRealTimers();
});

describe('delivery gating', () => {
  async function mount(input: { enabled: boolean; live: boolean }) {
    const collabs = makeCollaborators();
    const view = await renderHook(
      (props: { evaluatedAt: number; level: 'green' | 'amber' | 'red' }) =>
        useAlerts(
          {
            assessment: assessment([{ level: props.level }], props.evaluatedAt),
            enabled: input.enabled,
            live: input.live,
          },
          collabs,
        ),
      { initialProps: { evaluatedAt: T0, level: 'green' as const } },
    );
    return { collabs, view };
  }

  it('delivers when enabled, live, and granted', async () => {
    const { collabs, view } = await mount({ enabled: true, live: true });

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(1);
    expect(collabs.delivered[0]).toMatchObject({ level: 'red' });
  });

  it('never delivers on the simulated window, even with permission granted and alerts enabled', async () => {
    const { collabs, view } = await mount({ enabled: true, live: false });

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(0);
  });

  it('never delivers while the Settings toggle is off', async () => {
    const { collabs, view } = await mount({ enabled: false, live: true });

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(0);
  });

  it('never delivers before permission is granted', async () => {
    setMockPermission('undetermined');
    const { collabs, view } = await mount({ enabled: true, live: true });

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(0);
  });

  it('delivers once permission is granted from elsewhere, on the same already-mounted instance — no remount', async () => {
    // This is the scenario CRITICAL #1 (review round 1) was about: Settings grants the
    // permission while the Dashboard's `useAlerts` is already mounted and sitting at a red
    // category. The shared `useAlertPermission()` context is what has to carry that grant here.
    setMockPermission('undetermined');
    const { collabs, view } = await mount({ enabled: true, live: true });
    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });
    expect(collabs.delivered).toHaveLength(0);

    // The permission source changes value without the hook remounting — exactly what happens
    // when `AlertsProvider`'s own state updates and every consumer re-renders.
    setMockPermission('granted');
    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(1);
    expect(collabs.delivered[0]).toMatchObject({ level: 'red' });
  });

  it('re-enabling after a silent period treats the current level as a fresh evaluation', async () => {
    // While disabled, a rise must not quietly start the category's cooldown (module doc). Once
    // re-enabled, the still-elevated category should read as a notify-worthy rise, not as an
    // already-cooling-down repeat. Rerenders the *same* hook instance across the `enabled`
    // transition — a fresh `renderHook` (a remount) would trivially pass this by resetting the
    // planner's own state rather than proving the gate itself re-evaluates.
    const collabs = makeCollaborators();
    const view = await renderHook(
      (props: { evaluatedAt: number; enabled: boolean }) =>
        useAlerts(
          { assessment: assessment([{ level: 'red' }], props.evaluatedAt), enabled: props.enabled, live: true },
          collabs,
        ),
      { initialProps: { evaluatedAt: T0, enabled: false } },
    );
    expect(collabs.delivered).toHaveLength(0);

    await view.rerender({ evaluatedAt: T0 + 1, enabled: false });
    expect(collabs.delivered).toHaveLength(0);

    await view.rerender({ evaluatedAt: T0 + 1, enabled: true });

    expect(collabs.delivered).toHaveLength(1);
    expect(collabs.delivered[0]).toMatchObject({ level: 'red' });
  });

  it('does not re-plan or re-deliver when the assessment is unchanged (evaluatedAt stable)', async () => {
    const collabs = makeCollaborators();
    const view = await renderHook(
      (props: { evaluatedAt: number }) =>
        useAlerts(
          { assessment: assessment([{ level: 'red' }], props.evaluatedAt), enabled: true, live: true },
          collabs,
        ),
      { initialProps: { evaluatedAt: T0 } },
    );
    expect(collabs.delivered).toHaveLength(1);

    // Re-render with the exact same evaluatedAt (e.g. a parent re-render for an unrelated
    // reason) must not run the planner again.
    await view.rerender({ evaluatedAt: T0 });

    expect(collabs.delivered).toHaveLength(1);
  });

  it('delivers exactly once per intent, not once per rendered category', async () => {
    const collabs = makeCollaborators();
    const view = await renderHook(
      (props: { evaluatedAt: number }) =>
        useAlerts(
          {
            assessment: assessment(
              [
                { key: 'heat', level: 'red' },
                { key: 'respiratory', level: 'red' },
              ],
              props.evaluatedAt,
            ),
            enabled: true,
            live: true,
          },
          collabs,
        ),
      { initialProps: { evaluatedAt: T0 } },
    );

    expect(collabs.delivered).toHaveLength(2);
    expect(collabs.delivered.map((i) => i.category).sort()).toEqual(['heat', 'respiratory']);

    await view.rerender({ evaluatedAt: T0 + 1 });

    // Same levels, no new rise, no cooldown elapsed — still exactly two, not four.
    expect(collabs.delivered).toHaveLength(2);
  });
});

describe('a toggle flip within the cooldown window does not duplicate a delivered notification', () => {
  it('enabled → disabled → re-enabled, same red category, no second delivery inside the cooldown', async () => {
    const collabs = makeCollaborators();
    const view = await renderHook(
      (props: { evaluatedAt: number; enabled: boolean }) =>
        useAlerts(
          { assessment: assessment([{ level: 'red' }], props.evaluatedAt), enabled: props.enabled, live: true },
          collabs,
        ),
      { initialProps: { evaluatedAt: T0, enabled: true } },
    );
    expect(collabs.delivered).toHaveLength(1);

    // Off, then straight back on, well inside the 30-minute cooldown — the category was already
    // notified about this exact red condition a moment ago.
    await view.rerender({ evaluatedAt: T0 + 1, enabled: false });
    await view.rerender({ evaluatedAt: T0 + 2, enabled: true });

    expect(collabs.delivered).toHaveLength(1);
  });
});
