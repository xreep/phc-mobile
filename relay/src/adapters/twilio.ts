/**
 * Twilio SMS adapter — the "serious" SMS path. BUILT, NOT VALIDATED.
 *
 * Kept from the original relay design (docs/decisions/ADR-003-sos-relay.md) but disabled until
 * credentials exist: Twilio requires KYC plus a paid top-up for India-based accounts, which is why
 * Telegram and Textbelt lead today. Without all three of `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
 * and `TWILIO_FROM` the adapter reports `not configured` and never calls out.
 *
 * API: https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource
 * `POST /2010-04-01/Accounts/{SID}/Messages.json`, HTTP Basic auth, form-encoded, 201 on success.
 */

import type { Destination } from '../contract';
import type { Env } from '../env';
import { describe, readJson, upstream, type Adapter } from './types';

export const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export function twilioMessagesUrl(accountSid: string): string {
  return `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
}

function credentials(env: Env): { sid: string; token: string; from: string } | null {
  const sid = env.TWILIO_ACCOUNT_SID?.trim();
  const token = env.TWILIO_AUTH_TOKEN?.trim();
  const from = env.TWILIO_FROM?.trim();
  if (!sid || !token || !from) return null;
  return { sid, token, from };
}

export const twilio: Adapter = {
  name: 'twilio',
  kind: 'sms',
  notConfiguredError: 'not configured',
  notApplicableError: 'contact has no phone number',
  configured: (env: Env) => credentials(env) !== null,
  applicable: (to: Destination) => typeof to.phone === 'string',
  async send(to, message, env, options) {
    const creds = credentials(env);
    if (creds === null) return { ok: false, error: this.notConfiguredError };
    if (to.phone === undefined) return { ok: false, error: this.notApplicableError };

    const form = new URLSearchParams({ To: to.phone, From: creds.from, Body: message });
    const result = await upstream('twilio', twilioMessagesUrl(creds.sid), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${creds.sid}:${creds.token}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    }, options);
    if ('error' in result) return { ok: false, error: result.error };

    // Any 2xx (Twilio answers 201 Created). The body carries the message SID; nothing here needs it.
    if (result.response.ok) return { ok: true };

    const body = await readJson(result.response);
    const reason = describe(body, 'message') ?? 'unexpected response';
    const code = typeof body?.['code'] === 'number' ? ` [${body['code']}]` : '';
    return { ok: false, error: `twilio ${result.response.status}${code}: ${reason}` };
  },
};
