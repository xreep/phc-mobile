/**
 * Primary SOS path: the multi-channel emergency relay (PRD §7.2.5, ADR-007).
 *
 * ## What this deliberately does not know
 * No bot token, no Textbelt key, no Twilio credentials, no provider SDK. The app POSTs one
 * contact's destination and the composed message to a Worker URL and the Worker holds every
 * credential. That is the whole architectural point — `environment/openweather.ts` already
 * records why an `EXPO_PUBLIC_` variable is acceptable for a rate-limited weather key and
 * "emphatically not acceptable for the SOS phase's Twilio credentials", and this is the
 * indirection that resolves it. An `EXPO_PUBLIC_` value is extractable from any installed copy
 * of the app; a Worker URL is an endpoint, not a secret.
 *
 * ## The contract, as sent
 * `relay/src/contract.ts` is the truth; this file mirrors it and `__tests__/relay.test.ts` pins
 * the body by deep equality:
 *
 * ```
 * POST <EXPO_PUBLIC_SOS_RELAY_URL>
 * { "to": { "phone": "+91…", "telegramChatId": "123…" },   // chat id only when linked
 *   "message": "<composed by message.ts, sent verbatim>",
 *   "channels": ["telegram", "textbelt", "twilio"] }         // see relayChannelsFor
 * → 200 { "results": [{ "channel", "ok", "error"? }…], "delivered": true }
 * → 502 { …, "delivered": false }                            // every channel failed
 * ```
 *
 * ## Success is `2xx` **and** `delivered: true`
 * The Worker mirrors `delivered` onto the status code (200 vs 502), but this client does not
 * rely on the mirror: a 2xx whose body does not say `delivered: true` is a failure here. The
 * previous Twilio-only client accepted any 2xx blind because the function on the other side was
 * user-written; this relay is ours, its response shape is a contract, and the only evidence
 * that an emergency message reached a provider is that field.
 *
 * ## Failure is a first-class outcome
 * Nothing here throws. Every path — unset endpoint, DNS failure, timeout, 4xx, 5xx, a body
 * that is not the JSON we expect — returns `{ ok: false, error }`, because the caller's job
 * is to fall back to the native composer and it should not have to distinguish an exception
 * from a rejection to do it. A `try`/`catch` around the whole dispatch would have swallowed
 * the *reason*, which the UI needs to show.
 *
 * Nothing here logs. The message and the destination are the only health-adjacent data that
 * leave the phone, and a `console.*` of either would put them in a device log.
 */

import {
  RELAY_APP_KEY_HEADER,
  RELAY_TIMEOUT_MS,
  resolveRelayAppKey,
  resolveRelayEndpoint,
} from './config';
import type { EmergencyContact, SosChannel } from './types';

/** One row of the relay's `results`, narrowed to the channels this build knows. */
export type RelayChannelResult = {
  readonly channel: Exclude<SosChannel, 'native_sms'>;
  readonly ok: boolean;
  /** Short, safe-to-show reason from the relay. Never contains a token or key. */
  readonly error?: string;
};

export type RelaySendResult =
  | {
      readonly ok: true;
      /** Channels the relay reported `ok` for, in the relay's order. */
      readonly channels: readonly SosChannel[];
      readonly results: readonly RelayChannelResult[];
    }
  | {
      readonly ok: false;
      /** Human-readable, safe to show. Never contains the endpoint or a header. */
      readonly error: string;
      /** True when no endpoint is configured, so the caller can say "not configured"
       *  rather than "failed" — a materially different thing to tell a user. */
      readonly notConfigured?: boolean;
      /** Per-channel reasons when the relay answered with a body (502, or 2xx undelivered). */
      readonly results?: readonly RelayChannelResult[];
    };

export type RelaySendOptions = {
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to the global. Mirrors `environment/openweather.ts`. */
  readonly fetchImpl?: typeof fetch;
  /** Overrides the configured endpoint. Tests only — production reads the environment. */
  readonly endpoint?: string | null;
  readonly signal?: AbortSignal;
};

/** The relay channels an app request may name. `fcm` waits for the caregiver role (part 2). */
const RELAY_CHANNELS: readonly Exclude<SosChannel, 'native_sms'>[] = ['telegram', 'textbelt', 'twilio'];

function isRelayChannel(value: string): value is Exclude<SosChannel, 'native_sms'> {
  return (RELAY_CHANNELS as readonly string[]).includes(value);
}

/**
 * Which relay channels to ask for, for one contact.
 *
 * Telegram only when the contact has linked (the relay would otherwise answer `contact has no
 * telegramChatId`, a wasted row). Both SMS adapters whenever there is a number: the relay
 * skips the unconfigured one, and naming both means a deployment can switch Twilio on later
 * with an environment variable and no app release — the property ADR-007 was written for.
 */
export function relayChannelsFor(contact: EmergencyContact): readonly SosChannel[] {
  const channels: SosChannel[] = [];
  if (contact.telegramChatId !== undefined) channels.push('telegram');
  if (contact.phone.length > 0) channels.push('textbelt', 'twilio');
  return channels;
}

/** The "not configured" reason, shared with the linking flow so Settings says one thing. */
export const RELAY_NOT_CONFIGURED_ERROR =
  'No SOS relay configured. Set EXPO_PUBLIC_SOS_RELAY_URL in .env.local.';

/** A user-facing reason for a non-2xx relay status. Never names the endpoint. */
export function describeRelayStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'The SOS relay rejected the request (check the app key).';
  }
  if (status === 404) return 'The SOS relay URL was not found.';
  if (status === 429) return 'The SOS relay is rate limited.';
  if (status === 502) return 'The SOS relay could not deliver on any channel.';
  if (status === 503) return 'The SOS relay is not fully configured (503).';
  if (status >= 500) return `The SOS relay failed (${status}).`;
  return `The SOS relay returned an error (${status}).`;
}

const UNCONFIRMED = 'The SOS relay did not confirm delivery.';

type ParsedBody = {
  readonly delivered: boolean;
  readonly results: readonly RelayChannelResult[];
};

/**
 * Read the relay's JSON body, tolerating its absence.
 *
 * A body that is missing, not JSON, or not the expected shape yields `delivered: false` with no
 * rows — never an exception. Unknown channel names are dropped rather than rejected, for the
 * same reason the relay drops them on the way in: a newer relay may name an adapter this build
 * does not have yet.
 */
async function readBody(response: Response): Promise<ParsedBody> {
  let raw: unknown;
  try {
    raw = typeof response.json === 'function' ? await response.json() : undefined;
  } catch {
    raw = undefined;
  }
  if (typeof raw !== 'object' || raw === null) return { delivered: false, results: [] };

  const record = raw as Record<string, unknown>;
  const results: RelayChannelResult[] = [];
  if (Array.isArray(record.results)) {
    for (const entry of record.results) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.channel !== 'string' || !isRelayChannel(row.channel)) continue;
      if (typeof row.ok !== 'boolean') continue;
      results.push(
        typeof row.error === 'string'
          ? { channel: row.channel, ok: row.ok, error: row.error }
          : { channel: row.channel, ok: row.ok },
      );
    }
  }
  return { delivered: record.delivered === true, results };
}

/**
 * POST one alert for one contact to the relay.
 *
 * `contact.phone` must already be E.164 — `phone.ts` guarantees that at the store boundary, so
 * this does not re-validate and cannot disagree with what was stored. Likewise
 * `telegramChatId` is validated on read by `settings/store.ts`.
 */
export async function sendViaRelay(
  contact: EmergencyContact,
  message: string,
  options: RelaySendOptions = {},
): Promise<RelaySendResult> {
  const endpoint = options.endpoint === undefined ? resolveRelayEndpoint() : options.endpoint;

  if (endpoint === null) {
    return {
      ok: false,
      notConfigured: true,
      error: RELAY_NOT_CONFIGURED_ERROR,
    };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // A caller-supplied signal (the user cancelled, the screen unmounted) has to compose with
  // the timeout rather than replace it.
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const appKey = resolveRelayAppKey();
  if (appKey !== null) headers[RELAY_APP_KEY_HEADER] = appKey;

  // Built field by field so an unlinked contact sends no `telegramChatId` key at all — the
  // relay's validator accepts `undefined`, but the wire body is asserted by deep equality and
  // "absent" is the honest shape.
  const to: { phone: string; telegramChatId?: string } = { phone: contact.phone };
  if (contact.telegramChatId !== undefined) to.telegramChatId = contact.telegramChatId;

  try {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to, message, channels: relayChannelsFor(contact) }),
      signal: controller.signal,
    });

    const body = await readBody(response);

    if (!response.ok) {
      return body.results.length > 0
        ? { ok: false, error: describeRelayStatus(response.status), results: body.results }
        : { ok: false, error: describeRelayStatus(response.status) };
    }
    if (!body.delivered) {
      return body.results.length > 0
        ? { ok: false, error: UNCONFIRMED, results: body.results }
        : { ok: false, error: UNCONFIRMED };
    }
    return {
      ok: true,
      channels: body.results.filter((row) => row.ok).map((row) => row.channel),
      results: body.results,
    };
  } catch (error) {
    // Distinguishing the timeout matters: "timed out" tells the user the network was the
    // problem and the fallback is expected, where a generic failure reads like a bug.
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      error: aborted ? 'The SOS relay timed out.' : 'Could not reach the SOS relay.',
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
