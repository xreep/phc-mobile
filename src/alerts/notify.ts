/**
 * Thin side-effect layer over `expo-notifications` (Expo SDK 57 — API pinned against
 * https://docs.expo.dev/versions/v57.0.0/sdk/notifications/ and the installed package's own
 * `.d.ts` files, not memory of an earlier SDK).
 *
 * Nothing here decides *whether* to notify — that is `src/alerts/plan.ts`'s job, and it stays
 * pure specifically so it never has to import this file. This module only knows how to talk to
 * the OS: create the two Android channels, ask for permission, read the current permission, and
 * hand one already-decided {@link AlertIntent} to the system tray.
 *
 * ## Every exported function fails closed
 * A user is looking at a health dashboard, not a notifications settings screen — a missing
 * native module, a denied permission, or an OS quirk must degrade to "no notification appeared"
 * rather than an unhandled rejection breaking the Dashboard render. Every function below is
 * wrapped in try/catch for exactly that reason, even the read-only ones.
 *
 * ## Why delivery is channel-routed through the trigger, not the content
 * The obvious-looking shape, `content: { ..., channelId }`, does not exist on
 * `NotificationContentInput` in this SDK — checked directly against
 * `node_modules/expo-notifications/build/Notifications.types.d.ts` rather than assumed. Channel
 * selection for an immediate delivery is `trigger: { channelId }`
 * (`ChannelAwareTriggerInput`), which is also what makes each channel's importance and
 * vibration actually apply — passing `trigger: null` with no channel would land the
 * notification on Android's default channel and silently drop the MAX-importance/vibration
 * behaviour the critical channel exists for.
 */

import * as Notifications from 'expo-notifications';

import type { AlertIntent } from './plan';

/** Non-critical rises and same-level reminders. HIGH: a heads-up banner, no vibration pattern
 *  beyond the OS default. */
export const ALERT_CHANNEL_ID = 'phc-alerts';

/** PRD §7.2.5 critical triggers only. MAX importance plus an explicit vibration pattern, so a
 *  possible fall or a critical desaturation is not merely a quiet banner. */
export const CRITICAL_ALERT_CHANNEL_ID = 'phc-critical';

/** Collapsed to the three states the rest of the app needs to reason about — the iOS-specific
 *  provisional/ephemeral states in the SDK's own `IosAuthorizationStatus` are not distinctions
 *  this Android-first feature acts on differently. */
export type AlertPermission = 'granted' | 'denied' | 'undetermined';

function toPermission(status: string): AlertPermission {
  return status === 'granted' || status === 'denied' ? status : 'undetermined';
}

/**
 * Create (or update) both Android notification channels. Idempotent and safe to call on every
 * app start — Android only lets a channel's importance be set at creation, never adjusted after
 * (see the SDK's own note on `setNotificationChannelAsync`), so this must run before the first
 * notification is ever scheduled on either channel.
 *
 * A no-op on iOS and on any platform without channel support (`setNotificationChannelAsync`
 * resolves `null` there); nothing here checks the platform explicitly because the native module
 * itself is the thing that knows.
 */
export async function ensureAlertChannels(): Promise<void> {
  try {
    // Found on the first device run, not in any test: `expo-notifications` **suppresses a
    // notification that arrives while the app is in the foreground** unless a handler says to
    // show it — and since sensing is foreground-only today, *every* alert fires while the app is
    // open. Without this, the planner's intents were delivered to the OS and never displayed.
    // Banner + shade list, no sound (the critical channel's vibration pattern is the cue).
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    await Notifications.setNotificationChannelAsync(ALERT_CHANNEL_ID, {
      name: 'Risk alerts',
      importance: Notifications.AndroidImportance.HIGH,
    });
    await Notifications.setNotificationChannelAsync(CRITICAL_ALERT_CHANNEL_ID, {
      name: 'Critical alerts',
      importance: Notifications.AndroidImportance.MAX,
      enableVibrate: true,
      // Buzz, pause, buzz, pause (ms) — distinguishable from the default single-buzz pattern
      // the standard channel gets, without being long enough to read as a phone-call ringtone.
      vibrationPattern: [0, 250, 250, 250],
    });
  } catch {
    // A channel failing to create must not stop the app from starting. The next delivery
    // attempt targets a channel that was never created and fails closed there instead — no
    // notification appears, which is the same degradation as the permission being denied.
  }
}

/**
 * Raise the OS permission prompt. User-initiated only (brief §5 / Settings toggle) — the same
 * "never prompt in the background" discipline `useEnvironment`'s `canPrompt` documents, because
 * an unprompted dialog is how a permission gets permanently denied.
 */
export async function requestAlertPermission(): Promise<AlertPermission> {
  try {
    const response = await Notifications.requestPermissionsAsync();
    return toPermission(response.status);
  } catch {
    return 'undetermined';
  }
}

/** Read the current permission without prompting. */
export async function getAlertPermission(): Promise<AlertPermission> {
  try {
    const response = await Notifications.getPermissionsAsync();
    return toPermission(response.status);
  } catch {
    return 'undetermined';
  }
}

/**
 * Hand one planned intent to the OS. `data.category` is carried through (not shown) so a tap
 * could deep-link to the right card in a later milestone; nothing reads it yet.
 *
 * Never throws — see the module doc. The caller (`useAlerts`) never awaits this for control
 * flow, only to know when it is safe to consider the intent delivered.
 */
export async function deliverAlert(intent: AlertIntent): Promise<void> {
  try {
    const channelId = intent.critical ? CRITICAL_ALERT_CHANNEL_ID : ALERT_CHANNEL_ID;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: intent.title,
        body: intent.body,
        data: { category: intent.category },
      },
      trigger: { channelId },
    });
  } catch {
    // A notification failure must never throw into the Dashboard (brief §3).
  }
}
