/**
 * Telegram linking hook tests.
 *
 * The hook is the impure shell around `sos/telegram-link.ts`: it fetches the bot name, makes
 * the token, shows the link, and polls. What is worth pinning is the *cadence* and the
 * *stopping*, because both fail silently:
 *
 * - Polling faster than every 10 s eats the relay's per-IP budget that an SOS during linking
 *   would need (see the module header of `sos/telegram-link.ts`). Nothing in a happy-path test
 *   would notice.
 * - A poll that survives the editor closing keeps hitting the relay for ten minutes and then
 *   calls `setState` on an unmounted component. Nothing on screen would show it.
 */

import { act, renderHook } from '@testing-library/react-native';

import { useTelegramLink } from '@/hooks/use-telegram-link';
import { LINK_POLL_INTERVAL_MS, LINK_POLL_TIMEOUT_MS } from '@/sos/telegram-link';

const ENDPOINT = 'https://phc-sos-relay.example.workers.dev/sos';
const HEALTH = 'https://phc-sos-relay.example.workers.dev/health';
const LINK = 'https://phc-sos-relay.example.workers.dev/link';
/** What the global expo-crypto mock's bytes encode to (pinned in telegram-link.test.ts). */
const TOKEN = 'CzBVep_E6Q4zWH2ix-wRNg';

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === null ? Promise.reject(new SyntaxError('empty')) : Promise.resolve(body)),
  } as unknown as Response;
}

const HEALTHY = { ok: true, botUsername: 'phc_sos_bot', linking: true };

/**
 * A relay double: `/health` answers with the bot, `/link` answers from a queue of responses
 * (the last one repeats). Calls are counted per route so cadence is observable.
 */
function relay(linkReplies: readonly Response[], health: unknown = HEALTHY) {
  const queue = [...linkReplies];
  const fetchImpl = jest.fn<Promise<Response>, FetchArgs>(async (input) => {
    const url = String(input);
    if (url === HEALTH) return reply(200, health);
    if (url === LINK) {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next ?? reply(404, { error: 'not linked yet' });
    }
    throw new Error(`unexpected url ${url}`);
  });
  const linkCalls = () => fetchImpl.mock.calls.filter(([input]) => String(input) === LINK).length;
  const healthCalls = () => fetchImpl.mock.calls.filter(([input]) => String(input) === HEALTH).length;
  return { fetchImpl, linkCalls, healthCalls };
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

/** Let already-resolved promises inside the effect chain settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('starting', () => {
  it('fetches the bot name, then shows the deep link and starts waiting', async () => {
    const { fetchImpl, healthCalls } = relay([]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    expect(result.current.state).toEqual({ status: 'idle' });

    await act(async () => {
      result.current.start();
    });
    await settle();

    expect(healthCalls()).toBe(1);
    expect(result.current.state).toEqual({
      status: 'waiting',
      botUsername: 'phc_sos_bot',
      linkToken: TOKEN,
      link: `https://t.me/phc_sos_bot?start=${TOKEN}`,
    });
  });

  it('polls /link immediately after the health check, not after the first interval', async () => {
    // The caregiver may tap within seconds. Waiting a full interval before the first look is
    // ten seconds of "waiting…" for nothing.
    const { fetchImpl, linkCalls } = relay([]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();

    expect(linkCalls()).toBe(1);
  });

  it('says the relay is not configured, and does not poll', async () => {
    const { fetchImpl, linkCalls } = relay([]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: null, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();

    expect(result.current.state).toEqual({
      status: 'unavailable',
      error: 'No SOS relay configured. Set EXPO_PUBLIC_SOS_RELAY_URL in .env.local.',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await advance(LINK_POLL_INTERVAL_MS * 3);
    expect(linkCalls()).toBe(0);
  });

  it('says a relay without a bot cannot link', async () => {
    const { fetchImpl } = relay([], { ok: true, botUsername: null, linking: true });
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();

    expect(result.current.state).toEqual({
      status: 'unavailable',
      error: 'This relay is not set up for Telegram linking.',
    });
  });
});

describe('polling', () => {
  it('asks the relay every 10 s and no faster', async () => {
    const { fetchImpl, linkCalls } = relay([]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();
    expect(linkCalls()).toBe(1);

    await advance(LINK_POLL_INTERVAL_MS - 1);
    expect(linkCalls()).toBe(1);

    await advance(1);
    expect(linkCalls()).toBe(2);

    await advance(LINK_POLL_INTERVAL_MS * 3);
    expect(linkCalls()).toBe(5);
  });

  it('keeps waiting on 404 and stores the chat id once it arrives', async () => {
    const onLinked = jest.fn();
    const { fetchImpl, linkCalls } = relay([
      reply(404, { error: 'not linked yet' }),
      reply(404, { error: 'not linked yet' }),
      reply(200, { telegramChatId: '123456789' }),
    ]);
    const { result } = await renderHook(() =>
      useTelegramLink({ endpoint: ENDPOINT, fetchImpl, onLinked }),
    );

    await act(async () => {
      result.current.start();
    });
    await settle();
    expect(result.current.state).toMatchObject({ status: 'waiting' });

    await advance(LINK_POLL_INTERVAL_MS);
    expect(result.current.state).toMatchObject({ status: 'waiting' });

    await advance(LINK_POLL_INTERVAL_MS);
    expect(result.current.state).toEqual({ status: 'linked', telegramChatId: '123456789' });
    expect(onLinked).toHaveBeenCalledWith('123456789');
    expect(onLinked).toHaveBeenCalledTimes(1);

    // And it stops: the token was consumed, so another poll could only ever 404.
    const after = linkCalls();
    await advance(LINK_POLL_INTERVAL_MS * 3);
    expect(linkCalls()).toBe(after);
  });

  it('keeps waiting through a transient failure', async () => {
    // A 5xx or a dropped connection does not invalidate the token (the 429 case, which also
    // backs off a cycle, is below).
    const { fetchImpl } = relay([reply(500, null), reply(503, null), reply(200, { telegramChatId: '42' })]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();
    await advance(LINK_POLL_INTERVAL_MS);
    expect(result.current.state).toMatchObject({ status: 'waiting' });

    await advance(LINK_POLL_INTERVAL_MS);
    expect(result.current.state).toEqual({ status: 'linked', telegramChatId: '42' });
  });

  it('skips one cycle after a 429, then resumes the normal cadence', async () => {
    // The poll shares the relay's per-IP bucket with `/sos`. Polling again 10 s after a 429
    // spends the refill an emergency would need; waiting a cycle costs the caregiver ten seconds.
    const { fetchImpl, linkCalls } = relay([reply(429, null), reply(404, { error: 'not yet' })]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();
    expect(linkCalls()).toBe(1); // the immediate poll: 429

    await advance(LINK_POLL_INTERVAL_MS);
    expect(linkCalls()).toBe(1); // the skipped cycle
    expect(result.current.state).toMatchObject({ status: 'waiting' });

    await advance(LINK_POLL_INTERVAL_MS);
    expect(linkCalls()).toBe(2); // resumed

    await advance(LINK_POLL_INTERVAL_MS);
    expect(linkCalls()).toBe(3); // and back to every 10 s
  });

  it('stops with the reason on an answer that will not change', async () => {
    const { fetchImpl, linkCalls } = relay([reply(401, { error: 'invalid app key' })]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();

    expect(result.current.state).toEqual({
      status: 'failed',
      error: 'The SOS relay rejected the request (check the app key).',
    });
    const after = linkCalls();
    await advance(LINK_POLL_INTERVAL_MS * 2);
    expect(linkCalls()).toBe(after);
  });

  it('expires after ten minutes, matching the relay’s TTL', async () => {
    const { fetchImpl, linkCalls } = relay([]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();

    await advance(LINK_POLL_TIMEOUT_MS - LINK_POLL_INTERVAL_MS);
    expect(result.current.state).toMatchObject({ status: 'waiting' });

    await advance(LINK_POLL_INTERVAL_MS);
    expect(result.current.state).toEqual({ status: 'expired' });

    // 1 immediate + 59 interval polls inside the window; none after.
    const after = linkCalls();
    expect(after).toBe(LINK_POLL_TIMEOUT_MS / LINK_POLL_INTERVAL_MS);
    await advance(LINK_POLL_INTERVAL_MS * 3);
    expect(linkCalls()).toBe(after);
  });

  it('can start again after expiring, with a fresh token', async () => {
    const random = jest.mocked(jest.requireMock('expo-crypto').getRandomValues as jest.Mock);
    const { fetchImpl } = relay([]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();
    await advance(LINK_POLL_TIMEOUT_MS);
    expect(result.current.state).toEqual({ status: 'expired' });

    const draws = random.mock.calls.length;
    await act(async () => {
      result.current.start();
    });
    await settle();

    expect(result.current.state).toMatchObject({ status: 'waiting' });
    // A new draw, not a reuse: the old token is dead on the relay and a stale one would poll
    // 404 for another ten minutes.
    expect(random.mock.calls.length).toBe(draws + 1);
  });
});

describe('stopping', () => {
  it('stops polling when the component unmounts', async () => {
    const { fetchImpl, linkCalls } = relay([]);
    const { result, unmount } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();
    await advance(LINK_POLL_INTERVAL_MS);
    const before = linkCalls();

    await unmount();

    await advance(LINK_POLL_INTERVAL_MS * 5);
    expect(linkCalls()).toBe(before);
  });

  it('does not set state from a poll that resolves after unmount', async () => {
    // A `/link` response arriving after the editor closed. Without the guard this is React's
    // "state update on an unmounted component" — a warning in dev and a leak in release.
    let resolveLink: ((response: Response) => void) | undefined;
    const fetchImpl = jest.fn<Promise<Response>, FetchArgs>(async (input) => {
      if (String(input) === HEALTH) return reply(200, HEALTHY);
      return new Promise<Response>((resolve) => {
        resolveLink = resolve;
      });
    });
    const onLinked = jest.fn();
    const { result, unmount } = await renderHook(() =>
      useTelegramLink({ endpoint: ENDPOINT, fetchImpl, onLinked }),
    );

    await act(async () => {
      result.current.start();
    });
    await settle();
    expect(resolveLink).toBeDefined();

    await unmount();
    await act(async () => {
      resolveLink?.(reply(200, { telegramChatId: '123456789' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onLinked).not.toHaveBeenCalled();
  });

  it('reset returns to idle and stops polling', async () => {
    const { fetchImpl, linkCalls } = relay([]);
    const { result } = await renderHook(() => useTelegramLink({ endpoint: ENDPOINT, fetchImpl }));

    await act(async () => {
      result.current.start();
    });
    await settle();

    await act(async () => {
      result.current.reset();
    });
    expect(result.current.state).toEqual({ status: 'idle' });

    const after = linkCalls();
    await advance(LINK_POLL_INTERVAL_MS * 3);
    expect(linkCalls()).toBe(after);
  });
});
