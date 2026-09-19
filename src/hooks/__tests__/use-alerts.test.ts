/**
 * `useAlerts` tests.
 *
 * The planner (`@/alerts/plan`) and the OS layer (`@/alerts/notify`) are both unit-tested on
 * their own, so this suite is about the wiring: does the hook call the planner exactly when
 * `assessment.evaluatedAt` changes, and does it ever call `deliverAlert` outside
 * `enabled && live && permission === 'granted'`. Every collaborator is injected via the hook's
 * `*Impl` options rather than mocking `@/alerts/notify` module-wide, the same convention
 * `useSos`'s own tests use.
 *
 * As `src/__tests__/settings-screen.test.tsx` documents for `render`, react-native-testing-
 * library v14 makes `renderHook` and `rerender` async too — both are awaited throughout.
 */

import { act, renderHook } from '@testing-library/react-native';

import { assessment } from '@/alerts/__tests__/fixtures';
import type { AlertIntent } from '@/alerts/plan';
import type { AlertPermission } from '@/alerts/notify';
import { useAlerts } from '@/hooks/use-alerts';

const T0 = 1_700_000_000_000;

function makeCollaborators(initialPermission: AlertPermission = 'granted') {
  const delivered: AlertIntent[] = [];
  return {
    deliverImpl: jest.fn(async (intent: AlertIntent) => {
      delivered.push(intent);
    }),
    ensureChannelsImpl: jest.fn(async () => {}),
    getPermissionImpl: jest.fn(async () => initialPermission),
    requestPermissionImpl: jest.fn(async () => 'granted' as AlertPermission),
    delivered,
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('permission wiring', () => {
  it('reads the current permission on mount without prompting', async () => {
    const collabs = makeCollaborators('undetermined');

    const { result } = await renderHook(() =>
      useAlerts(
        { assessment: assessment([{ level: 'green' }]), enabled: true, live: true },
        collabs,
      ),
    );

    expect(collabs.getPermissionImpl).toHaveBeenCalledTimes(1);
    expect(collabs.requestPermissionImpl).not.toHaveBeenCalled();
    expect(result.current.permission).toBe('undetermined');
  });

  it('creates the notification channels on mount', async () => {
    const collabs = makeCollaborators();

    await renderHook(() =>
      useAlerts(
        { assessment: assessment([{ level: 'green' }]), enabled: true, live: true },
        collabs,
      ),
    );

    expect(collabs.ensureChannelsImpl).toHaveBeenCalledTimes(1);
  });

  it('updates permission after requestPermission resolves', async () => {
    const collabs = makeCollaborators('undetermined');

    const { result } = await renderHook(() =>
      useAlerts(
        { assessment: assessment([{ level: 'green' }]), enabled: true, live: true },
        collabs,
      ),
    );
    expect(result.current.permission).toBe('undetermined');

    await act(async () => {
      result.current.requestPermission();
      await Promise.resolve();
    });

    expect(collabs.requestPermissionImpl).toHaveBeenCalledTimes(1);
    expect(result.current.permission).toBe('granted');
  });
});

describe('delivery gating', () => {
  async function mount(input: { enabled: boolean; live: boolean }, permission: AlertPermission = 'granted') {
    const collabs = makeCollaborators(permission);
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
    const { collabs, view } = await mount({ enabled: true, live: true }, 'granted');

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(1);
    expect(collabs.delivered[0]).toMatchObject({ level: 'red' });
  });

  it('never delivers on the simulated window, even with permission granted and alerts enabled', async () => {
    const { collabs, view } = await mount({ enabled: true, live: false }, 'granted');

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(0);
  });

  it('never delivers while the Settings toggle is off', async () => {
    const { collabs, view } = await mount({ enabled: false, live: true }, 'granted');

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(0);
  });

  it('never delivers before permission is granted', async () => {
    const { collabs, view } = await mount({ enabled: true, live: true }, 'undetermined');

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });

    expect(collabs.delivered).toHaveLength(0);
  });

  it('re-enabling after a silent period treats the current level as a fresh evaluation', async () => {
    // While disabled, a rise must not quietly start the category's cooldown (module doc). Once
    // re-enabled, the still-elevated category should read as a notify-worthy rise, not as an
    // already-cooling-down repeat.
    const { collabs, view } = await mount({ enabled: false, live: true }, 'granted');

    await view.rerender({ evaluatedAt: T0 + 1, level: 'red' });
    expect(collabs.delivered).toHaveLength(0);

    await renderHook(
      (props: { evaluatedAt: number; level: 'green' | 'amber' | 'red' }) =>
        useAlerts(
          { assessment: assessment([{ level: props.level }], props.evaluatedAt), enabled: true, live: true },
          collabs,
        ),
      { initialProps: { evaluatedAt: T0 + 2, level: 'red' as const } },
    );

    expect(collabs.delivered).toHaveLength(1);
    expect(collabs.delivered[0]).toMatchObject({ level: 'red' });
  });

  it('does not re-plan or re-deliver when the assessment is unchanged (evaluatedAt stable)', async () => {
    const collabs = makeCollaborators('granted');
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
    const collabs = makeCollaborators('granted');
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
