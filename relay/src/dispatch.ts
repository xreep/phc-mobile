/**
 * Channel dispatch: given one contact, a message and the configured adapters, try channels and
 * report per-channel results. Pure apart from the adapters it is handed, so tests drive it with
 * fakes and the adapter tests cover the network.
 *
 * ## Plan
 * 1. The request's `channels` (unknown names already dropped by validation), **if at least one of
 *    them is configured**; otherwise the Worker's `CHANNEL_ORDER`. A request naming only an
 *    adapter this deployment lacks still gets the deployment's defaults — the alert goes out.
 * 2. With `SMS_ALWAYS=true` (the default) and a phone number present, the plan must contain a
 *    *configured* SMS adapter; if it does not, the preferred one (textbelt, then twilio) is
 *    appended. `channels: ['telegram', 'twilio']` with Twilio unconfigured still sends via Textbelt.
 * 3. **Every planned channel gets exactly one result row**: sent, failed, `not configured`,
 *    `contact has no …`, `skipped: already delivered`, or `deadline exceeded`. Nothing is dropped,
 *    so the phone can show why a channel did nothing.
 *
 * ## Time budget — the phone gives the whole call 10 s
 * Each adapter gets `DEFAULT_TIMEOUT_MS` (3.5 s) and the dispatch as a whole gets `DEADLINE_MS`
 * (8 s). An adapter that would start after the deadline gets a `deadline exceeded` row instead;
 * one that starts near it gets only the remaining time; and every in-flight `send()` is **raced
 * against the deadline**, so an adapter that ignores its abort signal is abandoned with a
 * `deadline exceeded` row rather than awaited. `dispatch()` never resolves later than
 * `DEADLINE_MS` after it started. The relay must always answer before the phone's own timer
 * fires, or the phone falls back to the composer without ever seeing that an SMS went out.
 *
 * ## Two lanes — "SMS always attempted if a phone number exists"
 * With `SMS_ALWAYS` and a phone number, the SMS lane runs **concurrently** with the data lane
 * (Telegram/FCM) rather than after it: a hung Telegram call must not eat the SMS's time. Telegram
 * reaching a phone does not mean the caregiver saw it — the Telegram app may be muted or logged
 * out — while an SMS lights the lock screen. An emergency deserves both.
 * - Data lane: sequential in plan order, stop at the first success (its own, or the SMS lane's).
 * - SMS lane: the first configured, applicable SMS adapter runs; on failure the next one runs only
 *   if the data lane has not delivered by then (exactly one SMS after a data success, so a
 *   free-tier day's quota is not doubled; a failed attempt sent nothing, so falling through when
 *   nothing else got out is right).
 * Without `SMS_ALWAYS` (or without a phone number) the plan runs sequentially and stops at the
 * first success of any kind.
 *
 * `delivered` is "any channel ok" — that is what the phone needs to decide between "sent" and
 * "open the composer".
 */

import { type Adapter, DEFAULT_TIMEOUT_MS, type SendOptions } from './adapters/types';
import { type ChannelName, type ChannelResult, type Destination, parseChannelOrder, type SosRequest, type SosResponse } from './contract';
import { type Env, flag } from './env';

export type AdapterMap = Readonly<Record<ChannelName, Adapter>>;

/** Whole-dispatch budget, under the phone's 10 s relay timeout. */
export const DEADLINE_MS = 8_000;

export interface DispatchOptions {
  /** Per-adapter upstream timeout. Defaults to `DEFAULT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Whole-dispatch budget. Defaults to `DEADLINE_MS`. */
  readonly deadlineMs?: number;
  /** Comma-separated default order; defaults to `env.CHANNEL_ORDER`. */
  readonly channelOrder?: string;
  /** Defaults to `env.SMS_ALWAYS`, itself defaulting to true. */
  readonly smsAlways?: boolean;
  /** Clock, injected by tests. */
  readonly now?: () => number;
}

/** Preferred SMS adapter order when SMS_ALWAYS has to add one the plan did not name. */
const SMS_PREFERENCE: readonly ChannelName[] = ['textbelt', 'twilio'];

export const SKIPPED_ERROR = 'skipped: already delivered';
export const DEADLINE_ERROR = 'deadline exceeded';
/** Sentinel the deadline promise resolves to; never a `SendResult`. */
const DEADLINE = Symbol('deadline');

function isSmsReady(adapter: Adapter, env: Env, to: Destination): boolean {
  return adapter.kind === 'sms' && adapter.configured(env) && adapter.applicable(to);
}

/** Work out which channels run, in order. Exported for tests. */
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
  if (smsAlways && request.to.phone !== undefined && !plan.some((name) => isSmsReady(adapters[name], env, request.to))) {
    const sms = SMS_PREFERENCE.find((name) => adapters[name].configured(env) && !plan.includes(name));
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
  const now = options.now ?? Date.now;
  const perAdapterMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadlineAt = now() + (options.deadlineMs ?? DEADLINE_MS);

  const results = new Map<ChannelName, ChannelResult>();
  const state = { delivered: false };

  // One timer for the whole dispatch. Every in-flight send races against it; once it fires, every
  // later race resolves immediately and the `remaining <= 0` check catches adapters not yet started.
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(DEADLINE), Math.max(0, deadlineAt - now()));
  });

  /** Run one planned adapter to a result row. Returns true on success. */
  const attempt = async (name: ChannelName): Promise<boolean> => {
    const adapter = adapters[name];
    if (!adapter.configured(env)) {
      results.set(name, { channel: name, ok: false, error: adapter.notConfiguredError });
      return false;
    }
    if (!adapter.applicable(request.to)) {
      results.set(name, { channel: name, ok: false, error: adapter.notApplicableError });
      return false;
    }
    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      results.set(name, { channel: name, ok: false, error: DEADLINE_ERROR });
      return false;
    }
    const sendOptions: SendOptions = { timeoutMs: Math.min(perAdapterMs, remaining) };
    const result = await Promise.race([adapter.send(request.to, request.message, env, sendOptions), deadline]);
    if (result === DEADLINE) {
      // The adapter is still running; it is abandoned, never awaited. Nothing it returns later
      // can change the response the phone already has.
      results.set(name, { channel: name, ok: false, error: DEADLINE_ERROR });
      return false;
    }
    results.set(name, result.ok ? { channel: name, ok: true } : { channel: name, ok: false, error: result.error });
    if (result.ok) state.delivered = true;
    return result.ok;
  };

  const skip = (name: ChannelName): void => {
    results.set(name, { channel: name, ok: false, error: SKIPPED_ERROR });
  };

  const twoLanes = smsAlways && request.to.phone !== undefined;

  if (!twoLanes) {
    // One lane: sequential, stop at the first success of any kind.
    let done = false;
    for (const name of plan) {
      if (done) skip(name);
      else done = await attempt(name);
    }
  } else {
    const dataLane = plan.filter((name) => adapters[name].kind === 'data');
    const smsLane = plan.filter((name) => adapters[name].kind === 'sms');

    const runData = async (): Promise<void> => {
      // Stops at its own first success, or once the SMS lane has delivered — a second data
      // channel after a lock-screen SMS adds nothing worth the time.
      for (const name of dataLane) {
        if (state.delivered) skip(name);
        else await attempt(name);
      }
    };

    const runSms = async (): Promise<void> => {
      let done = false;
      for (const name of smsLane) {
        if (done) {
          skip(name);
          continue;
        }
        const ready = isSmsReady(adapters[name], env, request.to);
        const ok = await attempt(name);
        // After a real SMS attempt that failed, fall through to the next SMS adapter only while
        // nothing at all has been delivered; one SMS attempt after a data success is the rule.
        done = ok || (ready && state.delivered);
      }
    };

    await Promise.all([runData(), runSms()]);
  }

  clearTimeout(deadlineTimer);
  return {
    results: plan.map((name) => results.get(name) ?? { channel: name, ok: false, error: SKIPPED_ERROR }),
    delivered: state.delivered,
  };
}

/** Convenience for `/health`: which adapters are configured on this deployment. */
export function configuredChannels(adapters: AdapterMap, env: Env): Record<ChannelName, boolean> {
  const out = {} as Record<ChannelName, boolean>;
  for (const adapter of Object.values(adapters)) out[adapter.name] = adapter.configured(env);
  return out;
}
