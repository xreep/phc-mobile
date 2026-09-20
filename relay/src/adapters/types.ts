/**
 * One adapter per provider. The dispatcher (src/dispatch.ts) only ever talks to this interface, so
 * adding a provider is a new file here plus a name in `CHANNEL_NAMES` — never an app change.
 *
 * ## Rules every adapter follows
 * - `send` never throws. Network errors, timeouts, non-2xx and unparseable bodies all come back as
 *   `{ ok: false, error }` because the dispatcher's job is to move on to the next channel.
 * - `error` is short and safe to return to the phone: an upstream status and its description, never
 *   a token, key, or URL with credentials in it.
 * - Nothing is logged. The message and the destination are the only health data that leave the
 *   phone, and they must not end up in Workers Logs.
 * - Every upstream call carries `AbortSignal.timeout(timeoutMs)` so a hung provider cannot eat the
 *   phone's own 10-second budget for the whole relay call.
 */

import type { ChannelName, Destination } from '../contract';
import type { Env } from '../env';

export type SendResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface SendOptions {
  /** Upstream timeout. Defaults to `DEFAULT_TIMEOUT_MS`; tests shorten it. */
  readonly timeoutMs?: number;
}

export interface Adapter {
  readonly name: ChannelName;
  /** 'sms' adapters count toward the SMS_ALWAYS rule; 'data' adapters do not. */
  readonly kind: 'sms' | 'data';
  /** Do the required secrets/vars exist? Cheap and pure — called on every request. */
  configured(env: Env): boolean;
  /** Reason shown when `configured` is false. Lets the FCM stub say "not implemented". */
  readonly notConfiguredError: string;
  /** Does this contact have the destination field this adapter needs? */
  applicable(to: Destination): boolean;
  /** Reason shown when `applicable` is false. */
  readonly notApplicableError: string;
  send(to: Destination, message: string, env: Env, options?: SendOptions): Promise<SendResult>;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

/** Run `fetch` with a timeout and map every failure mode to a `SendResult`-style error string. */
export async function upstream(
  label: string,
  input: string,
  init: RequestInit,
  options: SendOptions | undefined,
): Promise<{ readonly response: Response } | { readonly error: string }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const response = await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    return { response };
  } catch (cause) {
    // `AbortSignal.timeout` rejects with a DOMException named "TimeoutError"; a plain abort is
    // "AbortError". Both mean "the provider did not answer in time".
    const name = cause instanceof Error ? cause.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { error: `${label}: timed out` };
    return { error: `${label}: unreachable` };
  }
}

/** Read a JSON body without ever throwing. */
export async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Pull a short description out of an upstream error body, bounded so it stays a one-liner. */
export function describe(body: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  if (body === null) return undefined;
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 200);
  }
  return undefined;
}
