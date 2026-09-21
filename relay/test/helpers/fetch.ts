/**
 * `fetch` stubs. Every adapter test replaces the global with one of these via `vi.stubGlobal`
 * (vitest's `unstubGlobals: true` restores it after each test). No test in this package opens a
 * socket.
 */

import { vi } from 'vitest';

export interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
  /** Parsed form body when the request was `application/x-www-form-urlencoded`. */
  readonly form: URLSearchParams | null;
  /** Parsed JSON body when the request was `application/json`. */
  readonly json: unknown;
}

export interface FetchStub {
  readonly mock: ReturnType<typeof vi.fn>;
  readonly calls: CapturedCall[];
}

type Responder = (call: CapturedCall) => Response | Promise<Response>;

function capture(input: string | URL | Request, init: RequestInit | undefined): CapturedCall {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers = new Headers(init?.headers);
  const contentType = headers.get('content-type') ?? '';
  const body = typeof init?.body === 'string' ? init.body : null;
  return {
    url,
    init: init ?? {},
    form: body !== null && contentType.includes('x-www-form-urlencoded') ? new URLSearchParams(body) : null,
    json: body !== null && contentType.includes('json') ? JSON.parse(body) : undefined,
  };
}

/** Stub `fetch` with a responder; returns the captured calls for assertions. */
export function stubFetch(respond: Responder): FetchStub {
  const calls: CapturedCall[] = [];
  const mock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = capture(input, init);
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

/** Stub `fetch` to answer with one JSON body and status. */
export function stubFetchJson(status: number, body: unknown): FetchStub {
  return stubFetch(() => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

/** Stub `fetch` to reject like a DNS/socket failure. */
export function stubFetchNetworkError(): FetchStub {
  return stubFetch(() => {
    throw new TypeError('fetch failed');
  });
}

/**
 * Stub `fetch` to hang until the request's `signal` aborts, then reject the way the runtime does.
 * Proves the adapter actually wires `AbortSignal.timeout` rather than just mapping the error.
 */
export function stubFetchHang(): FetchStub {
  return stubFetch(
    (call) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = call.init.signal;
        if (!signal) {
          reject(new Error('test: request carried no AbortSignal'));
          return;
        }
        const fail = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      }),
  );
}
