/**
 * Twilio relay tests.
 *
 * Two things are pinned harder than the rest:
 *
 * 1. **The request body is exactly `{ to, message }`.** That shape is the contract with a
 *    serverless function the *user* writes and deploys, on the other side of a boundary this
 *    test suite cannot see. If the app starts sending `{ phone, body }`, nothing here fails at
 *    runtime — the function 400s or, worse, 200s while sending nothing, and the app reports a
 *    delivered alert. So the body is asserted by deep equality, not by "contains".
 * 2. **Nothing throws.** The caller's whole job is to fall back to the composer, and it decides
 *    that from a returned value. An exception escaping this module would abort the dispatch and
 *    take the fallback with it, turning a relay outage into a total failure to alert.
 */

import { sendViaTwilio } from '@/sos/twilio';

const ENDPOINT = 'https://phc-1234.twil.io/sos';
const TO = '+919876543210';
const MESSAGE = 'PHC EMERGENCY - Asha needs help.';

/**
 * Argument tuple for a `fetch` double.
 *
 * `Parameters<typeof fetch>` reads like the obvious spelling and is wrong: RN's `fetch` is
 * declared as overloads, and `Parameters` resolves only the *last* one (`input: RequestInfo`).
 * A mock typed from that is not assignable to `typeof fetch`, because it fails the first
 * overload's wider `URL | RequestInfo`. Declaring the widest input satisfies both.
 */
type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function ok(status = 200): Response {
  return { ok: status >= 200 && status < 300, status } as Response;
}

function notOk(status: number): Response {
  return { ok: false, status } as Response;
}

/** An `AbortError` shaped the way `fetch` raises one. */
function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

describe('sendViaTwilio', () => {
  it('POSTs exactly { to, message } as JSON', async () => {
    const fetchImpl = jest.fn<Promise<Response>, FetchArgs>().mockResolvedValue(ok());

    const result = await sendViaTwilio(TO, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });

    // Deep equality on the parsed body: the function on the other side reads these two keys
    // and nothing else, and an extra field would be a silent contract change.
    expect(JSON.parse(String(init?.body))).toEqual({ to: TO, message: MESSAGE });
  });

  it('sends the number as stored, without re-normalizing it', async () => {
    // `phone.ts` guarantees E.164 at the store boundary. A second normalization here could
    // disagree with what was saved, and the number the user verified in Settings would not be
    // the number that gets texted.
    const fetchImpl = jest.fn<Promise<Response>, FetchArgs>().mockResolvedValue(ok());

    await sendViaTwilio('+14155550123', MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)).to).toBe('+14155550123');
  });

  it('treats any 2xx as success without inspecting the body', async () => {
    // The relay's response shape is the user's business. Requiring a particular JSON envelope
    // would turn a successful send into a reported failure the moment they changed their
    // function's output — and `response.json()` on an empty 204 would throw.
    for (const status of [200, 201, 202, 204]) {
      const fetchImpl = jest
        .fn<Promise<Response>, FetchArgs>()
        .mockResolvedValue(ok(status));

      await expect(sendViaTwilio(TO, MESSAGE, { endpoint: ENDPOINT, fetchImpl })).resolves.toEqual({
        ok: true,
      });
    }
  });

  it('maps status codes to something a user can act on', async () => {
    const cases: readonly [number, string][] = [
      [401, 'The SOS relay rejected the request (check the function’s auth).'],
      [403, 'The SOS relay rejected the request (check the function’s auth).'],
      [404, 'The SOS relay URL was not found.'],
      [429, 'The SOS relay is rate limited.'],
      [500, 'The SOS relay failed (500).'],
      [503, 'The SOS relay failed (503).'],
      [418, 'The SOS relay returned an error (418).'],
    ];

    for (const [status, error] of cases) {
      const fetchImpl = jest
        .fn<Promise<Response>, FetchArgs>()
        .mockResolvedValue(notOk(status));

      await expect(sendViaTwilio(TO, MESSAGE, { endpoint: ENDPOINT, fetchImpl })).resolves.toEqual({
        ok: false,
        error,
      });
    }
  });

  it('never leaks the endpoint into an error message', async () => {
    // Errors are rendered in the SOS modal. A URL there is noise to the user and a detail worth
    // not putting on a screenshot.
    const fetchImpl = jest
      .fn<Promise<Response>, FetchArgs>()
      .mockResolvedValue(notOk(500));

    const result = await sendViaTwilio(TO, MESSAGE, { endpoint: ENDPOINT, fetchImpl });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toContain('twil.io');
  });

  it('reports a network failure as data rather than throwing', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, FetchArgs>()
      .mockRejectedValue(new TypeError('Network request failed'));

    await expect(sendViaTwilio(TO, MESSAGE, { endpoint: ENDPOINT, fetchImpl })).resolves.toEqual({
      ok: false,
      error: 'Could not reach the SOS relay.',
    });
  });

  it('names a timeout specifically, so the fallback reads as expected and not as a bug', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, FetchArgs>()
      .mockRejectedValue(abortError());

    await expect(sendViaTwilio(TO, MESSAGE, { endpoint: ENDPOINT, fetchImpl })).resolves.toEqual({
      ok: false,
      error: 'The SOS relay timed out.',
    });
  });

  it('aborts on its own timeout, so a hung request cannot hold the alert forever', async () => {
    jest.useFakeTimers();
    try {
      // A `fetch` that resolves only when its signal aborts — the shape of a request against a
      // black-holed connection, which is what "no connectivity" often looks like in practice.
      const fetchImpl = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(abortError()));
        });
      }) as unknown as typeof fetch;

      const pending = sendViaTwilio(TO, MESSAGE, {
        endpoint: ENDPOINT,
        fetchImpl,
        timeoutMs: 10_000,
      });

      jest.advanceTimersByTime(10_000);

      await expect(pending).resolves.toEqual({ ok: false, error: 'The SOS relay timed out.' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('honours a caller abort, and composes it with the timeout rather than replacing it', async () => {
    const controller = new AbortController();
    const fetchImpl = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(abortError()));
      });
    }) as unknown as typeof fetch;

    const pending = sendViaTwilio(TO, MESSAGE, {
      endpoint: ENDPOINT,
      fetchImpl,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: 'The SOS relay timed out.' });
  });

  it('says "not configured" rather than "failed" when there is no endpoint', async () => {
    // A materially different thing to tell a user: one is a build they can fix, the other looks
    // like an outage. The flag is what lets Settings show relay status before it is needed.
    const fetchImpl = jest.fn<Promise<Response>, FetchArgs>();

    const result = await sendViaTwilio(TO, MESSAGE, { endpoint: null, fetchImpl });

    expect(result).toEqual({
      ok: false,
      notConfigured: true,
      error: 'No SOS relay configured. Set EXPO_PUBLIC_TWILIO_SOS_URL in .env.local.',
    });
    // And it must not spend the 10-second timeout proving it.
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
