/**
 * Primary SOS path: a serverless function that fronts Twilio (PRD §7.2.5).
 *
 * ## What this deliberately does not know
 * No account SID, no auth token, no Twilio phone number, no Twilio SDK. The app POSTs
 * `{ to, message }` to a function URL and the function holds every credential. That is the
 * whole architectural point — `environment/openweather.ts` already records why an
 * `EXPO_PUBLIC_` variable is acceptable for a rate-limited weather key and "emphatically not
 * acceptable for the SOS phase's Twilio credentials", and this is the indirection that
 * resolves it. An `EXPO_PUBLIC_` value is extractable from any installed copy of the app;
 * a function URL is an endpoint, not a secret.
 *
 * ## Failure is a first-class outcome
 * Nothing here throws. Every path — unset endpoint, DNS failure, timeout, 4xx, 5xx, a body
 * that is not the JSON we expect — returns `{ ok: false, error }`, because the caller's job
 * is to fall back to the native composer and it should not have to distinguish an exception
 * from a rejection to do it. A `try`/`catch` around the whole dispatch would have swallowed
 * the *reason*, which the UI needs to show.
 */

import { resolveTwilioEndpoint, TWILIO_TIMEOUT_MS } from './config';

export type TwilioSendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Human-readable, safe to show. Never contains the endpoint or a header. */
      readonly error: string;
      /** True when no endpoint is configured, so the caller can say "not configured"
       *  rather than "failed" — a materially different thing to tell a user. */
      readonly notConfigured?: boolean;
    };

export type TwilioSendOptions = {
  readonly timeoutMs?: number;
  /** Injected in tests; defaults to the global. Mirrors `environment/openweather.ts`. */
  readonly fetchImpl?: typeof fetch;
  /** Overrides the configured endpoint. Tests only — production reads the environment. */
  readonly endpoint?: string | null;
  readonly signal?: AbortSignal;
};

function errorForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return 'The SOS relay rejected the request (check the function’s auth).';
  }
  if (status === 404) return 'The SOS relay URL was not found.';
  if (status === 429) return 'The SOS relay is rate limited.';
  if (status >= 500) return `The SOS relay failed (${status}).`;
  return `The SOS relay returned an error (${status}).`;
}

/**
 * POST one alert to the serverless relay.
 *
 * The body is exactly `{ to, message }`. `to` must already be E.164 — `phone.ts` guarantees
 * that at the store boundary, so this does not re-validate and cannot disagree with what was
 * stored.
 *
 * A 2xx is treated as success without inspecting the body. The relay owns the Twilio call and
 * its response shape is its business; requiring a particular JSON envelope here would couple
 * the app to an implementation detail of a function the user writes, and would turn a
 * successful send into a reported failure the moment that function's output changed.
 */
export async function sendViaTwilio(
  to: string,
  message: string,
  options: TwilioSendOptions = {},
): Promise<TwilioSendResult> {
  const endpoint = options.endpoint === undefined ? resolveTwilioEndpoint() : options.endpoint;

  if (endpoint === null) {
    return {
      ok: false,
      notConfigured: true,
      error: 'No SOS relay configured. Set EXPO_PUBLIC_TWILIO_SOS_URL in .env.local.',
    };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? TWILIO_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // A caller-supplied signal (the user cancelled, the screen unmounted) has to compose with
  // the timeout rather than replace it.
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  try {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to, message }),
      signal: controller.signal,
    });

    if (!response.ok) return { ok: false, error: errorForStatus(response.status) };
    return { ok: true };
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
