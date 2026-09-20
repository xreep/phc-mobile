/**
 * Channel dispatch: given one contact, a message and the configured adapters, try channels in
 * order and report per-channel results. Pure apart from the adapters it is handed, so tests drive
 * it with fakes and the adapter tests cover the network.
 *
 * ## Order
 * 1. The request's `channels` (unknown names already dropped by validation), **if at least one of
 *    them is configured**; otherwise the Worker's `CHANNEL_ORDER`. A request naming only an
 *    adapter this deployment lacks still gets the deployment's defaults — the alert goes out.
 * 2. Every channel in that plan gets a result row, including ones skipped for `not configured` or
 *    a missing destination field, so the phone can show *why* a channel did nothing.
 *
 * ## Stop rule — "SMS always attempted if a phone number exists"
 * Sequential; stop at the first success — except that with `SMS_ALWAYS=true` (the default) and a
 * phone number present, one SMS adapter is still attempted after a data-channel success. Telegram
 * reaching the caregiver's phone does not mean they saw it: the Telegram app may be muted or
 * logged out on a second device, while an SMS lights up the lock screen. An emergency deserves
 * both. Exactly one SMS adapter runs (textbelt preferred, then twilio — whichever is configured
 * and comes first in the plan; appended to the plan if it named none) so a free-tier day's quota
 * is not doubled. After an SMS success, no further channel runs.
 *
 * `delivered` is "any channel ok" — that is what the phone needs to decide between "sent" and
 * "open the composer".
 */

import type { Adapter, SendOptions } from './adapters/types';
import { type ChannelName, type ChannelResult, parseChannelOrder, type SosRequest, type SosResponse } from './contract';
import { type Env, flag } from './env';

export type AdapterMap = Readonly<Record<ChannelName, Adapter>>;

export interface DispatchOptions extends SendOptions {
  /** Comma-separated default order; defaults to `env.CHANNEL_ORDER`. */
  readonly channelOrder?: string;
  /** Defaults to `env.SMS_ALWAYS`, itself defaulting to true. */
  readonly smsAlways?: boolean;
}

/** Preferred SMS adapter order when SMS_ALWAYS has to pick one that the plan did not name. */
const SMS_PREFERENCE: readonly ChannelName[] = ['textbelt', 'twilio'];

/** Work out which channels run, in order. Exported for tests and for `/health` to describe. */
export function planChannels(
  request: Pick<SosRequest, 'to' | 'channels'>,
  adapters: AdapterMap,
  env: Env,
  options: DispatchOptions = {},
): readonly ChannelName[] {
  const defaults = parseChannelOrder(options.channelOrder ?? env.CHANNEL_ORDER);
  const requested = request.channels ?? [];
  const requestedUsable = requested.some((name) => adapters[name].configured(env));
  const plan: ChannelName[] = [...(requestedUsable ? requested : defaults)];

  const smsAlways = options.smsAlways ?? flag(env.SMS_ALWAYS, true);
  if (smsAlways && request.to.phone !== undefined && !plan.some((name) => adapters[name].kind === 'sms')) {
    const sms = SMS_PREFERENCE.find((name) => adapters[name].configured(env));
    if (sms !== undefined) plan.push(sms);
  }
  return plan;
}

export async function dispatch(
  request: SosRequest,
  adapters: AdapterMap,
  env: Env,
  options: DispatchOptions = {},
): Promise<SosResponse> {
  const plan = planChannels(request, adapters, env, options);
  const smsAlways = options.smsAlways ?? flag(env.SMS_ALWAYS, true);
  const sendOptions: SendOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };

  const results: ChannelResult[] = [];
  let delivered = false;
  let smsDone = false; // an SMS adapter was actually attempted (configured + applicable)

  for (const name of plan) {
    const adapter = adapters[name];
    const isSms = adapter.kind === 'sms';

    if (delivered) {
      // Only the SMS_ALWAYS top-up runs after a success, and only once.
      const wantSms = smsAlways && isSms && !smsDone && request.to.phone !== undefined;
      if (!wantSms) continue;
    }

    if (!adapter.configured(env)) {
      results.push({ channel: name, ok: false, error: adapter.notConfiguredError });
      continue;
    }
    if (!adapter.applicable(request.to)) {
      results.push({ channel: name, ok: false, error: adapter.notApplicableError });
      continue;
    }

    const result = await adapter.send(request.to, request.message, env, sendOptions);
    results.push(result.ok ? { channel: name, ok: true } : { channel: name, ok: false, error: result.error });

    if (isSms) smsDone = true;
    if (result.ok) {
      delivered = true;
      // An SMS success ends the run outright: nothing more to gain from a second SMS provider,
      // and no data channel is worth trying after the lock screen already lit up.
      if (isSms) break;
    }
  }

  return { results, delivered };
}

/** Convenience for `/health`: which adapters would run for a fully-populated contact. */
export function configuredChannels(adapters: AdapterMap, env: Env): Record<ChannelName, boolean> {
  const out = {} as Record<ChannelName, boolean>;
  for (const adapter of Object.values(adapters)) out[adapter.name] = adapter.configured(env);
  return out;
}
