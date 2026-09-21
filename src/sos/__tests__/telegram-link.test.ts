/**
 * Telegram linking primitives.
 *
 * The token is the security of the whole linking flow: the relay stores `link:<token> → chat id`
 * for ten minutes and hands the chat id to whoever presents the token first. So the two things
 * pinned here are that it is 128 bits from the platform CSPRNG (not `Math.random`, not a
 * six-digit code) and that its encoding is exactly the base64url the relay's `LINK_TOKEN` regex
 * accepts — a `+`, a `/` or a trailing `=` would be a 400 on every redemption, discovered only
 * when a real caregiver taps a real link.
 *
 * The `/health` and `/link` calls are thin; what matters is that they never throw and that a
 * 404 is "not yet", not "failed".
 */

import { getRandomValues } from 'expo-crypto';

import {
  fetchRelayBotUsername,
  generateLinkToken,
  isTelegramChatId,
  LINK_POLL_INTERVAL_MS,
  LINK_POLL_TIMEOUT_MS,
  LINK_TOKEN_PATTERN,
  normalizeTelegramChatId,
  redeemLinkToken,
  telegramDeepLink,
  telegramLinkInstructions,
} from '@/sos/telegram-link';

const ENDPOINT = 'https://phc-sos-relay.example.workers.dev/sos';

type FetchArgs = [input: RequestInfo | URL, init?: RequestInit];

function reply(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === null ? Promise.reject(new SyntaxError('empty')) : Promise.resolve(body)),
  } as unknown as Response;
}

function fetchMock(response: Response) {
  return jest.fn<Promise<Response>, FetchArgs>().mockResolvedValue(response);
}

describe('generateLinkToken', () => {
  it('asks the CSPRNG for exactly 16 bytes', () => {
    // 128 bits: the relay's `link.ts` explains why a guessable code is not safe even behind a
    // rate limit. `getRandomValues` is the expo-crypto entry point documented as
    // cryptographically secure; `getRandomBytes` is documented as falling back to
    // `Math.random` in development, which is why it is not the one used.
    jest.mocked(getRandomValues).mockClear();

    generateLinkToken();

    expect(getRandomValues).toHaveBeenCalledTimes(1);
    const [array] = jest.mocked(getRandomValues).mock.calls[0];
    expect(array).toBeInstanceOf(Uint8Array);
    expect(array).toHaveLength(16);
  });

  it('encodes the bytes as unpadded base64url — the shape the relay accepts', () => {
    // The global mock fills `i * 37 + 11`; this is that sequence's base64url, computed
    // independently. A `+`, `/` or `=` anywhere would fail the relay's `LINK_TOKEN` check.
    const token = generateLinkToken();

    expect(token).toBe('CzBVep_E6Q4zWH2ix-wRNg');
    expect(token).toMatch(LINK_TOKEN_PATTERN);
    expect(token).toHaveLength(22);
  });

  it('uses the URL-safe alphabet for the bytes that differ from standard base64', () => {
    // 0xfb 0xff 0xbf is the byte triple that encodes to `+/+/` in standard base64.
    const bytes = new Uint8Array(16);
    bytes.set([0xfb, 0xff, 0xbf]);
    expect(generateLinkToken(() => bytes)).toBe('-_-_AAAAAAAAAAAAAAAAAA');

    expect(generateLinkToken(() => new Uint8Array(16).fill(0xff))).toBe('_____________________w');
    expect(generateLinkToken(() => new Uint8Array(16))).toBe('AAAAAAAAAAAAAAAAAAAAAA');
  });

  it('matches the same regex the relay validates with', () => {
    expect(LINK_TOKEN_PATTERN.source).toBe('^[A-Za-z0-9_-]{22}$');
  });
});

describe('telegramDeepLink', () => {
  it('builds the t.me start link', () => {
    expect(telegramDeepLink('phc_sos_bot', 'CzBVep_E6Q4zWH2ix-wRNg')).toBe(
      'https://t.me/phc_sos_bot?start=CzBVep_E6Q4zWH2ix-wRNg',
    );
  });

  it('tolerates a leading @ on the bot name', () => {
    expect(telegramDeepLink('@phc_sos_bot', 'CzBVep_E6Q4zWH2ix-wRNg')).toBe(
      'https://t.me/phc_sos_bot?start=CzBVep_E6Q4zWH2ix-wRNg',
    );
  });
});

describe('telegramLinkInstructions', () => {
  it('tells the caregiver what to do, including the manual /start fallback', () => {
    // Telegram on some clients opens the bot without carrying the `start` payload; the manual
    // command is the only recovery that does not need a fresh token.
    const text = telegramLinkInstructions('phc_sos_bot', 'CzBVep_E6Q4zWH2ix-wRNg');
    expect(text).toContain('press Start');
    expect(text).toContain('/start CzBVep_E6Q4zWH2ix-wRNg');
    expect(text).toContain('@phc_sos_bot');
  });
});

describe('chat id validation', () => {
  it('accepts digits, optionally negative, up to 20 long', () => {
    expect(isTelegramChatId('123456789')).toBe(true);
    expect(isTelegramChatId('-1001234567890')).toBe(true);
    expect(isTelegramChatId('1'.repeat(20))).toBe(true);
  });

  it('rejects everything else', () => {
    for (const bad of ['', ' ', 'abc', '12a', '+123', '1'.repeat(21), '--1', '1.5']) {
      expect(isTelegramChatId(bad)).toBe(false);
    }
  });

  it('normalizes with trimming and drops anything unusable', () => {
    expect(normalizeTelegramChatId(' 123 ')).toBe('123');
    expect(normalizeTelegramChatId('abc')).toBeUndefined();
    expect(normalizeTelegramChatId('')).toBeUndefined();
    expect(normalizeTelegramChatId(123)).toBeUndefined(); // the relay wants a string
    expect(normalizeTelegramChatId(undefined)).toBeUndefined();
    expect(normalizeTelegramChatId(null)).toBeUndefined();
  });
});

describe('fetchRelayBotUsername', () => {
  it('GETs /health next to the configured /sos endpoint and returns the bot name', async () => {
    const fetchImpl = fetchMock(reply(200, { ok: true, botUsername: 'phc_sos_bot', linking: true }));

    const result = await fetchRelayBotUsername({ endpoint: ENDPOINT, fetchImpl });

    expect(result).toEqual({ ok: true, botUsername: 'phc_sos_bot' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://phc-sos-relay.example.workers.dev/health');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('reports a relay with no bot as not linkable', async () => {
    // `/health` says `botUsername: null` when `BOT_USERNAME` is unset, and `linking: false`
    // when the KV binding is missing. Either way the deep link cannot work, and the editor
    // must say so rather than show a link to nowhere.
    for (const body of [
      { ok: true, botUsername: null, linking: true },
      { ok: true, botUsername: 'phc_sos_bot', linking: false },
      { ok: true },
    ]) {
      const fetchImpl = fetchMock(reply(200, body));
      await expect(fetchRelayBotUsername({ endpoint: ENDPOINT, fetchImpl })).resolves.toEqual({
        ok: false,
        error: 'This relay is not set up for Telegram linking.',
      });
    }
  });

  it('says "not configured" when there is no relay URL, without fetching', async () => {
    const fetchImpl = fetchMock(reply(200, {}));

    await expect(fetchRelayBotUsername({ endpoint: null, fetchImpl })).resolves.toEqual({
      ok: false,
      notConfigured: true,
      error: 'No SOS relay configured. Set EXPO_PUBLIC_SOS_RELAY_URL in .env.local.',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws on a network failure or a bad status', async () => {
    const failing = jest
      .fn<Promise<Response>, FetchArgs>()
      .mockRejectedValue(new TypeError('Network request failed'));
    await expect(fetchRelayBotUsername({ endpoint: ENDPOINT, fetchImpl: failing })).resolves.toEqual({
      ok: false,
      error: 'Could not reach the SOS relay.',
    });

    await expect(
      fetchRelayBotUsername({ endpoint: ENDPOINT, fetchImpl: fetchMock(reply(500, null)) }),
    ).resolves.toEqual({ ok: false, error: 'The SOS relay failed (500).' });
  });
});

describe('redeemLinkToken', () => {
  const TOKEN = 'CzBVep_E6Q4zWH2ix-wRNg';

  it('POSTs { linkToken } to /link and returns the chat id once it is there', async () => {
    const fetchImpl = fetchMock(reply(200, { telegramChatId: '123456789' }));

    const result = await redeemLinkToken(TOKEN, { endpoint: ENDPOINT, fetchImpl });

    expect(result).toEqual({ status: 'linked', telegramChatId: '123456789' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://phc-sos-relay.example.workers.dev/link');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ linkToken: TOKEN });
  });

  it('sends the app key when one is configured', async () => {
    // `/link` sits behind the same gate as `/sos`.
    const original = process.env.EXPO_PUBLIC_SOS_RELAY_KEY;
    process.env.EXPO_PUBLIC_SOS_RELAY_KEY = 'phc-demo-key';
    try {
      const fetchImpl = fetchMock(reply(404, { error: 'not linked yet' }));
      await redeemLinkToken(TOKEN, { endpoint: ENDPOINT, fetchImpl });
      const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers['X-PHC-Key']).toBe('phc-demo-key');
    } finally {
      if (original === undefined) delete process.env.EXPO_PUBLIC_SOS_RELAY_KEY;
      else process.env.EXPO_PUBLIC_SOS_RELAY_KEY = original;
    }
  });

  it('treats 404 as "not yet", which is the normal answer while the caregiver has not tapped', async () => {
    const fetchImpl = fetchMock(reply(404, { error: 'not linked yet, expired or already used' }));

    await expect(redeemLinkToken(TOKEN, { endpoint: ENDPOINT, fetchImpl })).resolves.toEqual({
      status: 'pending',
    });
  });

  it('treats a transient failure as retryable rather than terminal', async () => {
    // A 429 from the shared bucket, a 5xx, or a dropped connection: the token is still valid
    // for the rest of its ten minutes, so the poll should carry on.
    for (const response of [reply(429, null), reply(500, null)]) {
      await expect(
        redeemLinkToken(TOKEN, { endpoint: ENDPOINT, fetchImpl: fetchMock(response) }),
      ).resolves.toEqual({ status: 'retry' });
    }
    const failing = jest
      .fn<Promise<Response>, FetchArgs>()
      .mockRejectedValue(new TypeError('Network request failed'));
    await expect(redeemLinkToken(TOKEN, { endpoint: ENDPOINT, fetchImpl: failing })).resolves.toEqual({
      status: 'retry',
    });
  });

  it('stops on an answer that will not change by waiting', async () => {
    // 401 is a wrong app key; 400 is a malformed token — neither fixes itself in ten minutes.
    await expect(
      redeemLinkToken(TOKEN, { endpoint: ENDPOINT, fetchImpl: fetchMock(reply(401, null)) }),
    ).resolves.toEqual({
      status: 'failed',
      error: 'The SOS relay rejected the request (check the app key).',
    });
    await expect(
      redeemLinkToken(TOKEN, { endpoint: ENDPOINT, fetchImpl: fetchMock(reply(400, null)) }),
    ).resolves.toEqual({ status: 'failed', error: 'The SOS relay returned an error (400).' });
  });

  it('rejects a chat id the relay should never have sent', async () => {
    // Defence in depth at the storage boundary: the store would drop it anyway, but a token
    // consumed for a value that then vanishes is a confusing failure. Better to say so now.
    const fetchImpl = fetchMock(reply(200, { telegramChatId: 'not-a-chat-id' }));

    await expect(redeemLinkToken(TOKEN, { endpoint: ENDPOINT, fetchImpl })).resolves.toEqual({
      status: 'failed',
      error: 'The SOS relay returned an unusable chat id.',
    });
  });

  it('fails without fetching when there is no relay', async () => {
    const fetchImpl = fetchMock(reply(200, {}));
    await expect(redeemLinkToken(TOKEN, { endpoint: null, fetchImpl })).resolves.toEqual({
      status: 'failed',
      error: 'No SOS relay configured. Set EXPO_PUBLIC_SOS_RELAY_URL in .env.local.',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('the polling constants', () => {
  it('polls every 10 s for up to 10 min', () => {
    // 10 s: the relay's per-IP bucket is 10 requests a minute *shared with `/sos`*. Six polls a
    // minute leaves four for an SOS that fires during linking; polling every 5 s would leave
    // none. 10 min: the relay's KV entry lives `LINK_TTL_SECONDS` = 600 s, so polling past
    // that can only ever see 404.
    expect(LINK_POLL_INTERVAL_MS).toBe(10_000);
    expect(LINK_POLL_TIMEOUT_MS).toBe(10 * 60_000);
  });
});
