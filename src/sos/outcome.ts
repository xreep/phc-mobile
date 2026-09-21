/**
 * Per-contact outcome lines for the SOS overlay ("Sent to Meera via Telegram").
 *
 * Pure: takes the dispatch result and the contact list, returns strings. Kept out of the
 * component so the wording — which carries the sent / waiting-for-your-tap distinction the
 * whole module is careful about — is tested as text rather than through a render.
 *
 * Channel names are collapsed for the reader: `textbelt` and `twilio` are both "SMS". Which
 * gateway carried the message is an operator's concern (the relay's `results` keep it for
 * the audit trail); what the user needs to know is that the person has it on a data channel,
 * an SMS, or both.
 */

import type { EmergencyContact, SosChannel, SosDispatchResult } from './types';

export type DispatchLine = {
  readonly contactId: string;
  readonly text: string;
};

function channelLabel(channel: SosChannel): string {
  return channel === 'telegram' ? 'Telegram' : 'SMS';
}

/** `['telegram', 'textbelt', 'twilio']` → "Telegram and SMS"; `['textbelt']` → "SMS". */
function describeChannels(channels: readonly SosChannel[]): string {
  const labels = [...new Set(channels.filter((c) => c !== 'native_sms').map(channelLabel))];
  return labels.join(' and ');
}

/**
 * One line per contact, in contact-list order.
 *
 * A contact the relay confirmed reads "Sent to <name> via <channels>". One that fell through to
 * the composer reads "Opened SMS app for <name>" while the composer is pending, and "SMS app
 * dismissed for <name>" when the user closed it — never "sent", because it was not. One with
 * no successful row at all reads "Could not reach <name>". A contact that has left the list
 * since the dispatch gets no line rather than a made-up name.
 */
export function describeDispatch(
  result: SosDispatchResult,
  contacts: readonly EmergencyContact[],
): readonly DispatchLine[] {
  const lines: DispatchLine[] = [];

  for (const contact of contacts) {
    const delivered = result.relayDelivered.find((d) => d.contactId === contact.id);
    if (delivered !== undefined) {
      const via = describeChannels(delivered.channels);
      lines.push({
        contactId: contact.id,
        text: via.length > 0 ? `Sent to ${contact.name} via ${via}` : `Sent to ${contact.name}`,
      });
      continue;
    }

    const composer = result.attempts.find(
      (a) => a.contactId === contact.id && a.channel === 'native_sms' && a.ok,
    );
    if (composer !== undefined) {
      lines.push({
        contactId: contact.id,
        text: result.nativeSmsPending
          ? `Opened SMS app for ${contact.name}`
          : `SMS app dismissed for ${contact.name}`,
      });
      continue;
    }

    const attempted = result.attempts.some((a) => a.contactId === contact.id);
    if (attempted) lines.push({ contactId: contact.id, text: `Could not reach ${contact.name}` });
  }

  return lines;
}
