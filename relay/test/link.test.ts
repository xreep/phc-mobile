import { describe, expect, it } from 'vitest';

import { TELEGRAM_API_BASE } from '../src/adapters/telegram';
import {
  createLinkCode,
  handleTelegramUpdate,
  LINK_TTL_SECONDS,
  linkCodeMessage,
  randomCode,
  redeemLinkCode,
  START_HELP,
} from '../src/link';
import { CHAT_ID, FAKE, makeEnv } from './helpers/env';
import { FakeKV } from './helpers/fake-kv';
import { stubFetchJson, stubFetchNetworkError } from './helpers/fetch';

function clock(start = 1_700_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('link codes', () => {
  it('randomCode is six zero-padded digits', () => {
    expect(randomCode(() => 7)).toBe('000007');
    expect(randomCode(() => 999_999)).toBe('999999');
    expect(randomCode()).toMatch(/^\d{6}$/);
  });

  it('createLinkCode stores chat id under the code with a 10-minute TTL', async () => {
    const kv = new FakeKV();
    const code = await createLinkCode(kv, CHAT_ID, () => 123_456);
    expect(code).toBe('123456');
    expect(kv.puts).toEqual([{ key: 'link:123456', value: CHAT_ID, expirationTtl: LINK_TTL_SECONDS }]);
    expect(LINK_TTL_SECONDS).toBe(600);
  });

  it('retries on collision with a live code', async () => {
    const kv = new FakeKV();
    const draws = [111_111, 111_111, 222_222];
    const first = await createLinkCode(kv, 'chat-a', () => draws.shift()!);
    const second = await createLinkCode(kv, 'chat-b', () => draws.shift()!);
    expect(first).toBe('111111');
    expect(second).toBe('222222');
    expect(await kv.get('link:111111')).toBe('chat-a');
    expect(await kv.get('link:222222')).toBe('chat-b');
  });

  it('gives up after repeated collisions instead of overwriting', async () => {
    const kv = new FakeKV();
    await createLinkCode(kv, 'chat-a', () => 5);
    await expect(createLinkCode(kv, 'chat-b', () => 5)).rejects.toThrow('could not allocate a link code');
    expect(await kv.get('link:000005')).toBe('chat-a');
  });

  it('redeemLinkCode is one-time', async () => {
    const kv = new FakeKV();
    const code = await createLinkCode(kv, CHAT_ID, () => 424_242);
    expect(await redeemLinkCode(kv, code)).toBe(CHAT_ID);
    expect(await redeemLinkCode(kv, code)).toBeNull();
    expect(kv.size).toBe(0);
  });

  it('redeemLinkCode returns null for an unknown code', async () => {
    expect(await redeemLinkCode(new FakeKV(), '000000')).toBeNull();
  });

  it('a code expires after ten minutes', async () => {
    const time = clock();
    const kv = new FakeKV(time.now);
    const code = await createLinkCode(kv, CHAT_ID, () => 777_777);
    time.advance(LINK_TTL_SECONDS * 1000 - 1);
    expect(await kv.get(`link:${code}`)).toBe(CHAT_ID);
    time.advance(1);
    expect(await redeemLinkCode(kv, code)).toBeNull();
  });
});

describe('handleTelegramUpdate', () => {
  const env = makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken });
  const update = (text: string, chatId: number | string = 123_456_789) => ({
    update_id: 1,
    message: { message_id: 1, text, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'A' } },
  });

  it('on /start mints a code, stores it, and replies with the code message', async () => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const outcome = await handleTelegramUpdate(update('/start'), env, kv, { random: () => 314_159 });

    expect(outcome).toEqual({ kind: 'code', chatId: '123456789', code: '314159' });
    expect(await kv.get('link:314159')).toBe('123456789');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.url).toBe(`${TELEGRAM_API_BASE}/bot${FAKE.telegramToken}/sendMessage`);
    expect(stub.calls[0]!.json).toMatchObject({ chat_id: '123456789', text: linkCodeMessage('314159') });
    expect(linkCodeMessage('314159')).toBe(
      'Your PHC link code is 314159 — enter it in the PHC app under Emergency contacts. Expires in 10 minutes.',
    );
  });

  it('accepts /start with a deep-link payload and a bot mention', async () => {
    stubFetchJson(200, { ok: true });
    expect((await handleTelegramUpdate(update('/start abc'), env, new FakeKV())).kind).toBe('code');
    expect((await handleTelegramUpdate(update('/start@phc_bot'), env, new FakeKV())).kind).toBe('code');
  });

  it('replies with help for any other text and stores nothing', async () => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    const outcome = await handleTelegramUpdate(update('hello?'), env, kv);
    expect(outcome).toEqual({ kind: 'help', chatId: '123456789' });
    expect(kv.size).toBe(0);
    expect(stub.calls[0]!.json).toMatchObject({ text: START_HELP });
    expect(START_HELP).not.toMatch(/diagnos/i);
  });

  it('ignores updates without a message text or chat', async () => {
    const stub = stubFetchJson(200, { ok: true });
    expect(await handleTelegramUpdate({ update_id: 2, edited_message: {} }, env, new FakeKV())).toEqual({ kind: 'ignored' });
    expect(await handleTelegramUpdate({ message: { chat: { id: 1 } } }, env, new FakeKV())).toEqual({ kind: 'ignored' });
    expect(await handleTelegramUpdate('garbage', env, new FakeKV())).toEqual({ kind: 'ignored' });
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('ignores everything when no bot token is configured', async () => {
    const stub = stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    expect(await handleTelegramUpdate(update('/start'), makeEnv(), kv)).toEqual({ kind: 'ignored' });
    expect(kv.size).toBe(0);
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('a failed reply does not throw and the code stays stored', async () => {
    stubFetchNetworkError();
    const kv = new FakeKV();
    const outcome = await handleTelegramUpdate(update('/start'), env, kv, { random: () => 1 });
    expect(outcome).toEqual({ kind: 'code', chatId: '123456789', code: '000001' });
    expect(await kv.get('link:000001')).toBe('123456789');
  });

  it('stringifies numeric and string chat ids alike', async () => {
    stubFetchJson(200, { ok: true });
    const kv = new FakeKV();
    await handleTelegramUpdate(update('/start', '-1001'), env, kv, { random: () => 2 });
    expect(await kv.get('link:000002')).toBe('-1001');
  });
});
