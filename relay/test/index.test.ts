import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TELEGRAM_API_BASE } from '../src/adapters/telegram';
import { TEXTBELT_URL } from '../src/adapters/textbelt';
import type { Env } from '../src/env';
import worker, { APP_KEY_HEADER, createHandler, safeEqual, TELEGRAM_SECRET_HEADER } from '../src/index';
import { RateLimiter } from '../src/ratelimit';
import { CHAT_ID, FAKE, fullEnv, makeEnv, MESSAGE, PHONE } from './helpers/env';
import { FakeKV } from './helpers/fake-kv';
import { type CapturedCall, stubFetch, stubFetchJson } from './helpers/fetch';

const BASE = 'https://relay.test';

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Provider-aware fetch stub: Telegram and Textbelt both succeed unless told otherwise. */
function stubProviders(overrides: { telegram?: Response; textbelt?: Response } = {}) {
  return stubFetch((call: CapturedCall) => {
    if (call.url.startsWith(TELEGRAM_API_BASE)) return overrides.telegram ?? Response.json({ ok: true });
    if (call.url === TEXTBELT_URL) return overrides.textbelt ?? Response.json({ success: true, quotaRemaining: 0 });
    return new Response('unexpected upstream', { status: 599 });
  });
}

// Re-created per test: vitest's `restoreMocks` restores spies after each test.
let consoleSpies: Record<'log' | 'error' | 'warn', ReturnType<typeof vi.spyOn>>;

beforeEach(() => {
  consoleSpies = {
    log: vi.spyOn(console, 'log').mockImplementation(() => undefined),
    error: vi.spyOn(console, 'error').mockImplementation(() => undefined),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  };
});

afterEach(() => {
  // No handler path may log payload contents. The 500 path logs an error *name* only (tested below).
  for (const spy of Object.values(consoleSpies)) {
    for (const call of spy.mock.calls) {
      const text = call.map(String).join(' ');
      expect(text).not.toContain(MESSAGE);
      expect(text).not.toContain(PHONE);
      expect(text).not.toContain(CHAT_ID);
    }
  }
});

describe('GET /health', () => {
  it('reports configured channels and order without secrets', async () => {
    const handler = createHandler();
    const response = await handler(new Request(`${BASE}/health`), fullEnv({ SMS_ALWAYS: 'false' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      service: 'phc-sos-relay',
      channels: { telegram: true, textbelt: true, twilio: true, fcm: false },
      channelOrder: ['telegram', 'textbelt'],
      smsAlways: false,
      linking: true,
    });
    expect(JSON.stringify(body)).not.toContain(FAKE.telegramToken);
  });

  it('rejects other methods', async () => {
    const response = await createHandler()(new Request(`${BASE}/health`, { method: 'POST' }), makeEnv());
    expect(response.status).toBe(405);
  });
});

describe('POST /sos', () => {
  it('legacy body { to: "<phone>", message } → 200 via the SMS adapter (telegram skipped)', async () => {
    const stub = stubProviders();
    const response = await createHandler()(post('/sos', { to: PHONE, message: MESSAGE }), fullEnv());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: false, error: 'contact has no telegramChatId' },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.form?.get('message')).toBe(MESSAGE);
  });

  it('structured body → telegram then one SMS (SMS_ALWAYS), 200', async () => {
    const stub = stubProviders();
    const response = await createHandler()(
      post('/sos', { to: { phone: PHONE, telegramChatId: CHAT_ID }, message: MESSAGE, channels: ['telegram', 'textbelt'] }),
      fullEnv(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(stub.calls.map((c) => c.url)).toEqual([`${TELEGRAM_API_BASE}/bot${FAKE.telegramToken}/sendMessage`, TEXTBELT_URL]);
  });

  it('502 with per-channel errors when nothing gets through', async () => {
    stubProviders({
      telegram: Response.json({ ok: false, description: 'chat not found' }, { status: 400 }),
      textbelt: Response.json({ success: false, error: 'Out of quota', quotaRemaining: 0 }),
    });
    const response = await createHandler()(post('/sos', { to: { phone: PHONE, telegramChatId: CHAT_ID }, message: MESSAGE }), fullEnv());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      delivered: false,
      results: [
        { channel: 'telegram', ok: false, error: 'telegram 400: chat not found' },
        { channel: 'textbelt', ok: false, error: 'textbelt: Out of quota (quotaRemaining: 0)' },
      ],
    });
  });

  it('502 on a deployment with no configured channel in the order', async () => {
    const stub = stubProviders();
    const response = await createHandler()(post('/sos', { to: { telegramChatId: CHAT_ID }, message: MESSAGE }), makeEnv({ CHANNEL_ORDER: 'telegram' }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ delivered: false, results: [{ channel: 'telegram', ok: false, error: 'not configured' }] });
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('400 on invalid JSON and on an invalid body', async () => {
    const stub = stubProviders();
    const handler = createHandler();
    const bad = await handler(post('/sos', '{not json'), fullEnv());
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'body must be JSON' });

    const invalid = await handler(post('/sos', { to: '12345', message: MESSAGE }), fullEnv());
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'to must be an E.164 phone number' });
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('405 for GET', async () => {
    const response = await createHandler()(new Request(`${BASE}/sos`), fullEnv());
    expect(response.status).toBe(405);
  });

  it('401 when RELAY_APP_KEY is set and the header is missing or wrong; passes when it matches', async () => {
    stubProviders();
    const handler = createHandler();
    const env = fullEnv({ RELAY_APP_KEY: FAKE.appKey });

    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(401);
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }, { [APP_KEY_HEADER]: 'nope' }), env)).status).toBe(401);
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }, { [APP_KEY_HEADER]: FAKE.appKey }), env)).status).toBe(200);
  });

  it('no app-key check when RELAY_APP_KEY is unset', async () => {
    stubProviders();
    expect((await createHandler()(post('/sos', { to: PHONE, message: MESSAGE }), fullEnv())).status).toBe(200);
  });

  it('429 once the per-IP bucket is empty; other IPs unaffected', async () => {
    stubProviders();
    const handler = createHandler({ limiter: new RateLimiter({ limit: 2, windowMs: 60_000 }) });
    const env = fullEnv();
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(200);
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(200);
    const limited = await handler(post('/sos', { to: PHONE, message: MESSAGE }), env);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate limited' });
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }, { 'CF-Connecting-IP': '198.51.100.2' }), env)).status).toBe(200);
  });

  it('reads RATE_LIMIT_PER_MINUTE from env for the default limiter', async () => {
    stubProviders();
    const handler = createHandler();
    const env = fullEnv({ RATE_LIMIT_PER_MINUTE: '1' });
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(200);
    expect((await handler(post('/sos', { to: PHONE, message: MESSAGE }), env)).status).toBe(429);
  });

  it('500 without leaking the payload when something throws', async () => {
    const handler = createHandler({
      adapters: {
        telegram: { name: 'telegram', kind: 'data', notConfiguredError: 'x', notApplicableError: 'y', configured: () => true, applicable: () => true, send: () => { throw new Error(`boom ${MESSAGE}`); } },
        textbelt: { name: 'textbelt', kind: 'sms', notConfiguredError: 'x', notApplicableError: 'y', configured: () => false, applicable: () => true, send: async () => ({ ok: true }) },
        twilio: { name: 'twilio', kind: 'sms', notConfiguredError: 'x', notApplicableError: 'y', configured: () => false, applicable: () => true, send: async () => ({ ok: true }) },
        fcm: { name: 'fcm', kind: 'data', notConfiguredError: 'x', notApplicableError: 'y', configured: () => false, applicable: () => true, send: async () => ({ ok: true }) },
      },
    });
    const response = await handler(post('/sos', { to: { telegramChatId: CHAT_ID }, message: MESSAGE }), makeEnv({ CHANNEL_ORDER: 'telegram' }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal error' });
    expect(consoleSpies.error).toHaveBeenCalledWith('relay: unhandled error', 'Error');
  });
});

describe('POST /link', () => {
  it('exchanges a live code once, then 404', async () => {
    const kv = new FakeKV();
    await kv.put('link:135790', CHAT_ID, { expirationTtl: 600 });
    const handler = createHandler();
    const env = makeEnv({}, kv);

    const first = await handler(post('/link', { code: '135790' }), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ telegramChatId: CHAT_ID });

    const second = await handler(post('/link', { code: '135790' }), env);
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ error: 'unknown or expired code' });
  });

  it('400 on a malformed code, 401 behind the app key, 429 when rate limited', async () => {
    const handler = createHandler({ limiter: new RateLimiter({ limit: 1, windowMs: 60_000 }) });
    // The gate runs before validation, so the 400 spends the only token; a 401 spends none.
    expect((await handler(post('/link', { code: '12' }), makeEnv())).status).toBe(400);
    expect((await handler(post('/link', { code: '123456' }), makeEnv({ RELAY_APP_KEY: FAKE.appKey }))).status).toBe(401);
    expect((await handler(post('/link', { code: '123456' }), makeEnv())).status).toBe(429);
  });
});

describe('POST /telegram/webhook', () => {
  const update = { update_id: 1, message: { message_id: 1, text: '/start', chat: { id: Number(CHAT_ID), type: 'private' } } };

  it('verifies the secret header when TELEGRAM_WEBHOOK_SECRET is set', async () => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const handler = createHandler({ random: () => 246_810 });
    const env = makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken, TELEGRAM_WEBHOOK_SECRET: FAKE.webhookSecret }, kv);

    expect((await handler(post('/telegram/webhook', update), env)).status).toBe(401);
    expect((await handler(post('/telegram/webhook', update, { [TELEGRAM_SECRET_HEADER]: 'wrong' }), env)).status).toBe(401);
    expect(kv.size).toBe(0);
    expect(stub.mock).not.toHaveBeenCalled();

    const ok = await handler(post('/telegram/webhook', update, { [TELEGRAM_SECRET_HEADER]: FAKE.webhookSecret }), env);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, handled: 'code' });
    expect(await kv.get('link:246810')).toBe(CHAT_ID);
    expect(stub.calls[0]!.json).toMatchObject({ chat_id: CHAT_ID, text: expect.stringContaining('246810') });
  });

  it('skips the secret check when none is configured', async () => {
    stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const response = await createHandler()(post('/telegram/webhook', update), makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken }, kv));
    expect(response.status).toBe(200);
    expect(kv.size).toBe(1);
  });

  it('full link round trip: /start → code → /link → chat id', async () => {
    stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const handler = createHandler({ random: () => 555_555 });
    const env = makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken }, kv);

    await handler(post('/telegram/webhook', update), env);
    const linked = await handler(post('/link', { code: '555555' }), env);
    expect(await linked.json()).toEqual({ telegramChatId: CHAT_ID });
    expect(kv.size).toBe(0);
  });

  it('is not gated by the app key or the rate limiter (Telegram is the caller)', async () => {
    stubFetchJson(200, { ok: true });
    const handler = createHandler({ limiter: new RateLimiter({ limit: 1, windowMs: 60_000 }) });
    const env = makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken, RELAY_APP_KEY: FAKE.appKey });
    for (let i = 0; i < 3; i += 1) {
      expect((await handler(post('/telegram/webhook', update), env)).status).toBe(200);
    }
  });

  it('400 on non-JSON, 200 ignored on an unrelated update', async () => {
    const handler = createHandler();
    const env = makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken });
    expect((await handler(post('/telegram/webhook', 'nope'), env)).status).toBe(400);
    const ignored = await handler(post('/telegram/webhook', { update_id: 3, channel_post: {} }), env);
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toEqual({ ok: true, handled: 'ignored' });
  });
});

describe('routing', () => {
  it('404 for unknown paths and tolerates a trailing slash', async () => {
    const handler = createHandler();
    expect((await handler(new Request(`${BASE}/nope`), makeEnv())).status).toBe(404);
    expect((await handler(new Request(`${BASE}/health/`), makeEnv())).status).toBe(200);
  });

  it('the default export wires the real handler', async () => {
    // The runtime hands the handler a Request carrying `cf` properties; a plain one is fine here.
    const request = new Request(`${BASE}/health`) as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(request, makeEnv());
    expect(response.status).toBe(200);
  });

  it('500 when the LINKS binding is missing on a link route', async () => {
    const response = await createHandler()(post('/link', { code: '123456' }), { CHANNEL_ORDER: '' } as unknown as Env);
    expect(response.status).toBe(500);
  });
});

describe('safeEqual', () => {
  it('compares exact strings only', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'a')).toBe(false);
  });
});
