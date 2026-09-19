/**
 * One notification-permission state for the whole app (M3 alerts).
 *
 * Same reasoning as `sensors/provider.tsx` and `settings/provider.tsx`: two places read and act
 * on this — the Settings "Alert notifications" row requests it and shows the "blocked" notice,
 * and the Dashboard's `useAlerts` gates delivery on it — and because Expo Router keeps every tab
 * mounted at once, two independent copies would disagree. A grant made from Settings has to reach
 * the Dashboard's already-mounted hook without a remount, and a single `useContext` read is what
 * makes that automatic: React re-renders every consumer when the provider's state changes,
 * whichever tab is currently visible.
 *
 * ## What actually happened without this file
 * `useAlerts` used to own a private `useState<AlertPermission>` and read it once, in a mount-only
 * effect, calling `getAlertPermission()` itself. The Settings screen owned a *second*,
 * independent copy the same way, and called `requestAlertPermission()` from its own toggle. The
 * two never talked to each other: granting the permission from Settings updated Settings' own
 * state, but the Dashboard's hook — mounted the whole time, per the Expo Router note above — kept
 * believing `'undetermined'` for the rest of the process's life. On Android 13+, where the
 * permission starts undetermined, this meant `useAlerts`'s gate (`enabled && live && permission
 * === 'granted'`) never opened until the app was killed and relaunched, silently. This file fixes
 * that by making "the current permission" one piece of state both places read.
 *
 * ## Why permission is also re-read on `AppState` 'active'
 * The OS permission dialog itself backgrounds and re-foregrounds the app while it is on screen,
 * and a user who instead grants the permission from Android's own notification settings (outside
 * the app entirely) also returns here via a foreground transition. Neither path calls
 * `requestPermission`, so without this the provider's state would only ever reflect what this
 * app's own prompt returned, not what the user did afterwards in system settings.
 *
 * ## Why permission is also re-read when the Settings toggle flips to enabled
 * The toggle can be off while the OS permission state changes underneath it (e.g. the user grants
 * or revokes notifications for this app from Android settings without ever touching the toggle).
 * Re-reading exactly on the false → true transition means the gate `useAlerts` checks is current
 * the moment it starts to matter, rather than only as fresh as the last foreground transition.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { ensureAlertChannels, getAlertPermission, requestAlertPermission, type AlertPermission } from './notify';

import { useSettings } from '@/settings/provider';

export type AlertsPermissionStore = {
  readonly permission: AlertPermission;
  /** Re-read the current permission without prompting. */
  readonly refreshPermission: () => void;
  /** Raise the OS permission prompt. Call this only from a user-initiated handler (a press),
   *  never from an effect — see `notify.ts`'s module doc. */
  readonly requestPermission: () => void;
};

const AlertsContext = createContext<AlertsPermissionStore | null>(null);

export function AlertsProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [permission, setPermission] = useState<AlertPermission>('undetermined');

  // Guards every `setState` after an await, same discipline as `useEnvironment`'s `mounted` ref:
  // a read or request that resolves after unmount must not update a dead component.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshPermission = useCallback(() => {
    void getAlertPermission().then((next) => {
      if (mounted.current) setPermission(next);
    });
  }, []);

  const requestPermission = useCallback(() => {
    void requestAlertPermission().then((next) => {
      if (mounted.current) setPermission(next);
    });
  }, []);

  // Channels must exist before Android 13+ will even offer the permission prompt
  // (`docs/features/notifications.md` records the verification). Created exactly once, here —
  // the single place in the app that does this now; see the module doc on why a second call
  // elsewhere would be redundant, not merely harmless.
  useEffect(() => {
    void ensureAlertChannels();
    refreshPermission();
  }, [refreshPermission]);

  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'active') refreshPermission();
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [refreshPermission]);

  const alertsEnabled = settings.alerts.enabled;
  const wasEnabled = useRef(alertsEnabled);
  useEffect(() => {
    if (alertsEnabled && !wasEnabled.current) refreshPermission();
    wasEnabled.current = alertsEnabled;
  }, [alertsEnabled, refreshPermission]);

  return (
    <AlertsContext.Provider value={{ permission, refreshPermission, requestPermission }}>
      {children}
    </AlertsContext.Provider>
  );
}

/**
 * Throws when no provider is mounted, deliberately — an inert default would let `useAlerts`
 * silently gate on `'undetermined'` forever, exactly the bug this file exists to fix, with
 * nothing reporting a fault.
 */
export function useAlertPermission(): AlertsPermissionStore {
  const store = useContext(AlertsContext);
  if (store === null) {
    throw new Error('useAlertPermission must be used inside an <AlertsProvider>.');
  }
  return store;
}
