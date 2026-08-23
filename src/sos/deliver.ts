/**
 * SOS delivery orchestration (PRD §7.2.5 step 2: "send SMS via Twilio … or native SMS
 * intent as offline fallback").
 *
 * ## The escalation, and why it is per-contact
 * Twilio is attempted for every contact first, concurrently. Whoever it could not reach — a
 * failure, a timeout, or no relay configured at all — is then rolled into a single native
 * composer. Falling back per-contact rather than all-or-nothing matters because the two
 * common partial failures are opposite: a relay that is up but rejects one malformed number,
 * and a relay that is down for everyone. Retrying the whole list through the composer in the
 * first case would ask the user to manually re-send messages that already went out, and
 * duplicate emergency texts are their own kind of harm.
 *
 * ## Concurrent, not sequential
 * Contacts are dispatched with `Promise.all`. Sequential sends would add the full relay
 * timeout per failing contact — three unreachable contacts at 10 s each is 30 s before the
 * fallback composer even opens, on top of the 30 s cancel window already spent.
 */

import { composeSosMessage } from './message';
import { sendViaNativeSms, type NativeSmsOptions } from './native-sms';
import type {
  EmergencyContact,
  SosContext,
  SosDeliveryAttempt,
  SosDispatchResult,
} from './types';
import { sendViaTwilio, type TwilioSendOptions } from './twilio';

export type DispatchOptions = {
  readonly twilio?: TwilioSendOptions;
  readonly sms?: NativeSmsOptions;
  /**
   * Skip the relay entirely and go straight to the composer.
   *
   * Not a test hook — this is the "no connectivity" branch PRD §7.2.5 calls for. The caller
   * knows the network is down (a failed environment refresh, a `NetInfo` state) and there is
   * no reason to spend 10 s of an emergency proving it again.
   */
  readonly skipTwilio?: boolean;
};

/**
 * Run the full escalation for one alert.
 *
 * Never throws. Both channels report failure as data, and the caller needs the breakdown to
 * tell the user which contacts were actually reached.
 */
export async function dispatchSos(
  contacts: readonly EmergencyContact[],
  context: SosContext,
  options: DispatchOptions = {},
): Promise<SosDispatchResult> {
  const message = composeSosMessage(context);

  if (contacts.length === 0) {
    return {
      attempts: [],
      twilioSent: [],
      nativeSmsPending: false,
      failed: true,
      message,
    };
  }

  const attempts: SosDeliveryAttempt[] = [];
  const unreached: EmergencyContact[] = [];
  const twilioSent: string[] = [];

  if (options.skipTwilio === true) {
    unreached.push(...contacts);
  } else {
    const results = await Promise.all(
      contacts.map(async (contact) => ({
        contact,
        result: await sendViaTwilio(contact.phone, message, options.twilio),
      })),
    );

    for (const { contact, result } of results) {
      attempts.push({
        contactId: contact.id,
        phone: contact.phone,
        channel: 'twilio',
        ok: result.ok,
        error: result.ok ? undefined : result.error,
      });

      if (result.ok) {
        twilioSent.push(contact.id);
      } else {
        unreached.push(contact);
      }
    }
  }

  let nativeSmsPending = false;

  if (unreached.length > 0) {
    const smsResult = await sendViaNativeSms(
      unreached.map((contact) => contact.phone),
      message,
      options.sms,
    );

    // One composer covers every unreached contact, but the attempt is recorded per contact so
    // the UI can show a complete row per person rather than a single opaque "SMS" line.
    for (const contact of unreached) {
      attempts.push({
        contactId: contact.id,
        phone: contact.phone,
        channel: 'native_sms',
        ok: smsResult.ok,
        error: smsResult.ok ? undefined : smsResult.error,
      });
    }

    // `cancelled` is not pending: the user saw the composer and dismissed it, so nothing is
    // waiting for them and telling them otherwise would be wrong. It is also not a failure
    // worth escalating — they made a choice.
    nativeSmsPending = smsResult.ok && smsResult.outcome !== 'cancelled';
  }

  return {
    attempts,
    twilioSent,
    nativeSmsPending,
    // Failed only when nothing at all got out. A composer that opened counts as progress even
    // though it needs a tap, because the user can still complete it.
    failed: twilioSent.length === 0 && !nativeSmsPending,
    message,
  };
}

export { composeSosMessage };
export type { SosContext, SosDispatchResult };
