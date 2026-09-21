/**
 * SOS delivery orchestration (PRD §7.2.5 step 2: "send SMS via Twilio … or native SMS
 * intent as offline fallback" — now "via the relay", ADR-007).
 *
 * ## The escalation, and why it is per-contact
 * The relay is attempted for every contact first, concurrently. Whoever it could not reach — a
 * failure, a timeout, or no relay configured at all — is then rolled into a single native
 * composer. Falling back per-contact rather than all-or-nothing matters because the two
 * common partial failures are opposite: a relay that is up but cannot deliver to one contact
 * (no Telegram link, SMS quota spent), and a relay that is down for everyone. Retrying the
 * whole list through the composer in the first case would ask the user to manually re-send
 * messages that already went out, and duplicate emergency texts are their own kind of harm.
 *
 * ## "Reached" means the relay said `delivered: true`
 * A contact whose Telegram message landed but whose SMS did not is reached — one channel is
 * enough to put the alert in front of a person, and the composer does not open for them. Both
 * rows are still recorded, so the UI can say "sent via Telegram" rather than implying both.
 *
 * ## Concurrent, not sequential
 * Contacts are dispatched with `Promise.all`. Sequential sends would add the full relay
 * timeout per failing contact — three unreachable contacts at 10 s each is 30 s before the
 * fallback composer even opens, on top of the 30 s cancel window already spent.
 */

import { composeSosMessage } from './message';
import { sendViaNativeSms, type NativeSmsOptions } from './native-sms';
import { relayChannelsFor, sendViaRelay, type RelaySendOptions } from './relay';
import type {
  EmergencyContact,
  SosContext,
  SosDeliveryAttempt,
  SosDispatchResult,
  SosRelayDelivery,
} from './types';

export type DispatchOptions = {
  readonly relay?: RelaySendOptions;
  readonly sms?: NativeSmsOptions;
  /**
   * Skip the relay entirely and go straight to the composer.
   *
   * Not a test hook — this is the "no connectivity" branch PRD §7.2.5 calls for. The caller
   * knows the network is down (a failed environment refresh, a `NetInfo` state) and there is
   * no reason to spend 10 s of an emergency proving it again.
   */
  readonly skipRelay?: boolean;
};

/**
 * Run the full escalation for one alert.
 *
 * Never throws. Both paths report failure as data, and the caller needs the breakdown to
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
      relayDelivered: [],
      nativeSmsPending: false,
      failed: true,
      message,
    };
  }

  const attempts: SosDeliveryAttempt[] = [];
  const unreached: EmergencyContact[] = [];
  const relayDelivered: SosRelayDelivery[] = [];

  if (options.skipRelay === true) {
    unreached.push(...contacts);
  } else {
    const results = await Promise.all(
      contacts.map(async (contact) => ({
        contact,
        result: await sendViaRelay(contact, message, options.relay),
      })),
    );

    for (const { contact, result } of results) {
      // Both arms of the union carry `results` (required on success, optional on failure).
      const rows = result.results;
      const overallError = result.ok ? undefined : result.error;
      if (rows !== undefined) {
        // The relay answered per channel. One row each, verbatim, so the UI can say which
        // lane carried the alert and why the other did not.
        for (const row of rows) {
          attempts.push({
            contactId: contact.id,
            phone: contact.phone,
            channel: row.channel,
            ok: row.ok,
            error: row.ok ? undefined : (row.error ?? overallError),
          });
        }
      } else {
        // The relay was not reached, or answered without per-channel rows (timeout, network,
        // 401, unconfigured). Every channel this contact would have used gets the same reason,
        // so the audit trail still has one row per channel per contact.
        for (const channel of relayChannelsFor(contact)) {
          attempts.push({
            contactId: contact.id,
            phone: contact.phone,
            channel,
            ok: false,
            error: overallError,
          });
        }
      }

      if (result.ok) {
        relayDelivered.push({ contactId: contact.id, channels: result.channels });
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
    relayDelivered,
    nativeSmsPending,
    // Failed only when nothing at all got out. A composer that opened counts as progress even
    // though it needs a tap, because the user can still complete it.
    failed: relayDelivered.length === 0 && !nativeSmsPending,
    message,
  };
}

export { composeSosMessage };
export type { SosContext, SosDispatchResult };
