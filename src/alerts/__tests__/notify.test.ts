/**
 * `src/alerts/notify.ts` tests — the thin side-effect layer between the pure planner and
 * `expo-notifications`. `jest/setup-after-env.js` mocks the whole module globally (inert:
 * undetermined permission, no delivery), so every test here overrides only the calls it cares
 * about and asserts against the mocked functions directly.
 */

import * as Notifications from 'expo-notifications';

import type { AlertIntent } from '@/alerts/plan';
import {
  ALERT_CHANNEL_ID,
  CRITICAL_ALERT_CHANNEL_ID,
  deliverAlert,
  ensureAlertChannels,
  getAlertPermission,
  requestAlertPermission,
} from '@/alerts/notify';

const mockedSetChannel = jest.mocked(Notifications.setNotificationChannelAsync);
const mockedGetPermissions = jest.mocked(Notifications.getPermissionsAsync);
const mockedRequestPermissions = jest.mocked(Notifications.requestPermissionsAsync);
const mockedSchedule = jest.mocked(Notifications.scheduleNotificationAsync);

const INTENT: AlertIntent = {
  category: 'respiratory',
  level: 'red',
  critical: false,
  title: 'Respiratory risk: high',
  body: 'Blood oxygen is below normal.',
  evaluatedAt: 1_700_000_000_000,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ensureAlertChannels', () => {
  it('registers a foreground handler that shows the banner and shade entry', async () => {
    // Found on the first Android 15 device run: without a handler, expo-notifications drops
    // any notification that arrives while the app is open — and every alert does, because
    // sensing is foreground-only. The planner's intents were "delivered" and never shown.
    const mockedSetHandler = jest.mocked(Notifications.setNotificationHandler);
    mockedSetHandler.mockClear();

    await ensureAlertChannels();

    expect(mockedSetHandler).toHaveBeenCalledTimes(1);
    const handler = mockedSetHandler.mock.calls[0][0]?.handleNotification;
    expect(handler).toBeDefined();
    await expect(handler!({} as never)).resolves.toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
    });
  });

  it('creates the standard channel at HIGH importance', async () => {
    await ensureAlertChannels();

    expect(mockedSetChannel).toHaveBeenCalledWith(
      ALERT_CHANNEL_ID,
      expect.objectContaining({ importance: Notifications.AndroidImportance.HIGH }),
    );
  });

  it('creates the critical channel at MAX importance, with vibration', async () => {
    await ensureAlertChannels();

    expect(mockedSetChannel).toHaveBeenCalledWith(
      CRITICAL_ALERT_CHANNEL_ID,
      expect.objectContaining({
        importance: Notifications.AndroidImportance.MAX,
        enableVibrate: true,
        vibrationPattern: expect.any(Array),
      }),
    );
  });

  it('swallows a failure instead of throwing into the Dashboard', async () => {
    mockedSetChannel.mockRejectedValueOnce(new Error('no channel support'));

    await expect(ensureAlertChannels()).resolves.toBeUndefined();
  });
});

describe('requestAlertPermission', () => {
  it('reports granted', async () => {
    mockedRequestPermissions.mockResolvedValueOnce({
      status: Notifications.PermissionStatus.GRANTED,
      granted: true,
      canAskAgain: true,
      expires: 'never',
    });

    await expect(requestAlertPermission()).resolves.toBe('granted');
  });

  it('reports denied', async () => {
    mockedRequestPermissions.mockResolvedValueOnce({
      status: Notifications.PermissionStatus.DENIED,
      granted: false,
      canAskAgain: false,
      expires: 'never',
    });

    await expect(requestAlertPermission()).resolves.toBe('denied');
  });

  it('falls back to undetermined on failure, rather than throwing', async () => {
    mockedRequestPermissions.mockRejectedValueOnce(new Error('native module missing'));

    await expect(requestAlertPermission()).resolves.toBe('undetermined');
  });
});

describe('getAlertPermission', () => {
  it('reads the current status without prompting', async () => {
    mockedGetPermissions.mockResolvedValueOnce({
      status: Notifications.PermissionStatus.UNDETERMINED,
      granted: false,
      canAskAgain: true,
      expires: 'never',
    });

    await expect(getAlertPermission()).resolves.toBe('undetermined');
    expect(mockedRequestPermissions).not.toHaveBeenCalled();
  });

  it('falls back to undetermined on failure', async () => {
    mockedGetPermissions.mockRejectedValueOnce(new Error('native module missing'));

    await expect(getAlertPermission()).resolves.toBe('undetermined');
  });
});

describe('deliverAlert', () => {
  it('schedules on the standard channel for a non-critical intent', async () => {
    await deliverAlert(INTENT);

    expect(mockedSchedule).toHaveBeenCalledWith({
      content: {
        title: INTENT.title,
        body: INTENT.body,
        data: { category: INTENT.category },
      },
      trigger: { channelId: ALERT_CHANNEL_ID },
    });
  });

  it('schedules on the critical channel for a critical intent', async () => {
    await deliverAlert({ ...INTENT, critical: true, title: 'Emergency: possible fall detected' });

    expect(mockedSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: { channelId: CRITICAL_ALERT_CHANNEL_ID } }),
    );
  });

  it('never throws into the caller when scheduling fails', async () => {
    mockedSchedule.mockRejectedValueOnce(new Error('no permission'));

    await expect(deliverAlert(INTENT)).resolves.toBeUndefined();
  });
});
