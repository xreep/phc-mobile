/**
 * Fallback SOS path: the platform SMS composer (PRD §7.2.5).
 *
 * PRD §8 makes this mandatory rather than optional — "SOS SMS fallback must not depend on
 * mobile data/WiFi". A `sms:` intent is handed to the dialer and travels over the cellular
 * control channel, so it works with data off, on a 2G-only tower, and in a disaster where the
 * data network is saturated but voice/SMS still carries.
 *
 * ## The honest limitation, stated once and carried everywhere
 * An SMS *intent* opens the composer pre-filled. It does **not** send. Android and iOS both
 * reserve the send action for the user — deliberately, since an app that could silently text
 * arbitrary numbers is a premium-rate fraud vector — and no Expo or native API changes that.
 *
 * So this path cannot report delivery, only that the composer was opened. Every type in this
 * module and in `types.ts` says `pending` rather than `sent` for that reason, and the UI tells
 * the user their message is waiting for a tap. Reporting it as sent would be the single most
 * dangerous lie in the app: someone would put the phone down believing help was coming.
 *
 * The consequence for an unconscious user is real and unavoidable at this layer — which is
 * exactly why the Twilio relay is the primary path and this is the fallback, not the reverse.
 */

import * as SMS from 'expo-sms';

export type NativeSmsResult =
  | {
      readonly ok: true;
      /**
       * What the platform reported. `sent` from `expo-sms` means the composer's send action
       * was taken; `cancelled` means it was dismissed; `unknown` is iOS declining to say.
       * Present only when the composer closed while the app was still foregrounded.
       */
      readonly outcome: 'sent' | 'cancelled' | 'unknown';
    }
  | { readonly ok: false; readonly error: string };

export type NativeSmsOptions = {
  /** Injected in tests. Defaults to `expo-sms`. */
  readonly smsImpl?: {
    isAvailableAsync: () => Promise<boolean>;
    sendSMSAsync: (
      recipients: string | string[],
      message: string,
    ) => Promise<{ result: string }>;
  };
};

/**
 * Open the composer addressed to every contact, pre-filled with the alert.
 *
 * All recipients go into **one** composer rather than one per contact. Sequential composers
 * would each need a separate user action and, worse, iOS only surfaces one at a time — so the
 * second contact's message would sit behind the first with nothing indicating it existed. One
 * multi-recipient message is a single tap for the whole contact list.
 *
 * `isAvailableAsync` is checked first because a tablet, an emulator, or a device with no SIM
 * has no SMS capability at all, and calling `sendSMSAsync` there rejects with a message that
 * reads like a bug rather than a missing radio.
 */
export async function sendViaNativeSms(
  recipients: readonly string[],
  message: string,
  options: NativeSmsOptions = {},
): Promise<NativeSmsResult> {
  const sms = options.smsImpl ?? SMS;

  if (recipients.length === 0) {
    return { ok: false, error: 'No emergency contacts to message.' };
  }

  try {
    if (!(await sms.isAvailableAsync())) {
      return { ok: false, error: 'This device cannot send SMS.' };
    }

    const { result } = await sms.sendSMSAsync([...recipients], message);

    // `expo-sms` documents `sent` | `cancelled` | `unknown`. Anything else is a version skew,
    // and treating it as `unknown` is right: the composer did open, which is all this path
    // ever promises.
    const outcome = result === 'sent' || result === 'cancelled' ? result : 'unknown';
    return { ok: true, outcome };
  } catch {
    return { ok: false, error: 'Could not open the SMS composer.' };
  }
}
