/**
 * Textbelt SMS adapter — real SMS with no account and no KYC.
 *
 * The literal key "textbelt" is the free tier: one message per day per source IP (the Worker's
 * egress IP, so effectively one per day for the whole deployment). A paid key removes the cap.
 * Because the default key always exists, this adapter counts as configured on every deployment;
 * remove it from `CHANNEL_ORDER` to switch it off.
 *
 * API: https://textbelt.com/ — `POST /text` (form-encoded) → `{ success, textId?, quotaRemaining, error? }`
 */

import type { Destination } from '../contract';
import type { Env } from '../env';
import { describe, readJson, upstream, type Adapter } from './types';

export const TEXTBELT_URL = 'https://textbelt.com/text';
export const TEXTBELT_FREE_KEY = 'textbelt';

export function textbeltKey(env: Env): string {
  const key = env.TEXTBELT_KEY?.trim();
  return key !== undefined && key.length > 0 ? key : TEXTBELT_FREE_KEY;
}

export const textbelt: Adapter = {
  name: 'textbelt',
  kind: 'sms',
  notConfiguredError: 'not configured',
  notApplicableError: 'contact has no phone number',
  configured: () => true,
  applicable: (to: Destination) => typeof to.phone === 'string',
  async send(to, message, env, options) {
    if (to.phone === undefined) return { ok: false, error: this.notApplicableError };

    const form = new URLSearchParams({ phone: to.phone, message, key: textbeltKey(env) });
    const result = await upstream('textbelt', TEXTBELT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }, options);
    if ('error' in result) return { ok: false, error: result.error };

    const body = await readJson(result.response);
    if (result.response.ok && body?.['success'] === true) return { ok: true };

    // Surface the quota so the operator can tell "free send used up today" from a real failure.
    const reason = describe(body, 'error') ?? `http ${result.response.status}`;
    const quota = body?.['quotaRemaining'];
    const suffix = typeof quota === 'number' ? ` (quotaRemaining: ${quota})` : '';
    return { ok: false, error: `textbelt: ${reason}${suffix}` };
  },
};
