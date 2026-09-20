import { describe, expect, it } from 'vitest';

import { fcm, FCM_NOT_IMPLEMENTED } from '../src/adapters/fcm';
import { telegram, TELEGRAM_API_BASE } from '../src/adapters/telegram';
import { textbelt, TEXTBELT_FREE_KEY, TEXTBELT_URL } from '../src/adapters/textbelt';
import { twilio, TWILIO_API_BASE } from '../src/adapters/twilio';
import { CHAT_ID, FAKE, fullEnv, makeEnv, MESSAGE, PHONE } from './helpers/env';
import { stubFetch, stubFetchHang, stubFetchJson, stubFetchNetworkError } from './helpers/fetch';

const SHORT = { timeoutMs: 20 };

describe('telegram adapter', () => {
  it('is configured only with a bot token and applies only with a chat id', () => {
    expect(telegram.configured(makeEnv())).toBe(false);
    expect(telegram.configured(makeEnv({ TELEGRAM_BOT_TOKEN: '' }))).toBe(false);
    expect(telegram.configured(makeEnv({ TELEGRAM_BOT_TOKEN: FAKE.telegramToken }))).toBe(true);
    expect(telegram.applicable({ phone: PHONE })).toBe(false);
    expect(telegram.applicable({ telegramChatId: CHAT_ID })).toBe(true);
  });

  it('POSTs sendMessage with the chat id and the verbatim text', async () => {
    const stub = stubFetchJson(200, { ok: true, result: { message_id: 1 } });
    const result = await telegram.send({ telegramChatId: CHAT_ID }, MESSAGE, fullEnv());

    expect(result).toEqual({ ok: true });
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toBe(`${TELEGRAM_API_BASE}/bot${FAKE.telegramToken}/sendMessage`);
    expect(call.init.method).toBe('POST');
    expect(call.json).toEqual({ chat_id: CHAT_ID, text: MESSAGE, disable_web_page_preview: false });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports the API description on an HTTP error, without the token', async () => {
    stubFetchJson(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' });
    const result = await telegram.send({ telegramChatId: CHAT_ID }, MESSAGE, fullEnv());
    expect(result).toEqual({ ok: false, error: 'telegram 400: Bad Request: chat not found' });
    expect(JSON.stringify(result)).not.toContain(FAKE.telegramToken);
  });

  it('treats a 200 whose body says ok:false as a failure', async () => {
    stubFetchJson(200, { ok: false, description: 'weird' });
    expect(await telegram.send({ telegramChatId: CHAT_ID }, MESSAGE, fullEnv())).toEqual({
      ok: false,
      error: 'telegram 200: weird',
    });
  });

  it('handles a non-JSON body', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 502 }));
    expect(await telegram.send({ telegramChatId: CHAT_ID }, MESSAGE, fullEnv())).toEqual({
      ok: false,
      error: 'telegram 502: unexpected response',
    });
  });

  it('times out through AbortSignal.timeout', async () => {
    stubFetchHang();
    expect(await telegram.send({ telegramChatId: CHAT_ID }, MESSAGE, fullEnv(), SHORT)).toEqual({
      ok: false,
      error: 'telegram: timed out',
    });
  });

  it('maps a network failure', async () => {
    stubFetchNetworkError();
    expect(await telegram.send({ telegramChatId: CHAT_ID }, MESSAGE, fullEnv())).toEqual({
      ok: false,
      error: 'telegram: unreachable',
    });
  });

  it('never calls out when not configured or not applicable', async () => {
    const stub = stubFetchJson(200, { ok: true });
    expect(await telegram.send({ telegramChatId: CHAT_ID }, MESSAGE, makeEnv())).toEqual({ ok: false, error: 'not configured' });
    expect(await telegram.send({ phone: PHONE }, MESSAGE, fullEnv())).toEqual({
      ok: false,
      error: 'contact has no telegramChatId',
    });
    expect(stub.mock).not.toHaveBeenCalled();
  });
});

describe('textbelt adapter', () => {
  it('is always configured (free key by default) and needs a phone number', () => {
    expect(textbelt.configured(makeEnv())).toBe(true);
    expect(textbelt.applicable({ telegramChatId: CHAT_ID })).toBe(false);
    expect(textbelt.applicable({ phone: PHONE })).toBe(true);
  });

  it('POSTs the form with the free key when TEXTBELT_KEY is unset', async () => {
    const stub = stubFetchJson(200, { success: true, textId: '1', quotaRemaining: 0 });
    const result = await textbelt.send({ phone: PHONE }, MESSAGE, makeEnv());

    expect(result).toEqual({ ok: true });
    const call = stub.calls[0]!;
    expect(call.url).toBe(TEXTBELT_URL);
    expect(call.init.method).toBe('POST');
    expect(call.form?.get('phone')).toBe(PHONE);
    expect(call.form?.get('message')).toBe(MESSAGE);
    expect(call.form?.get('key')).toBe(TEXTBELT_FREE_KEY);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the paid key when set', async () => {
    const stub = stubFetchJson(200, { success: true });
    await textbelt.send({ phone: PHONE }, MESSAGE, fullEnv());
    expect(stub.calls[0]!.form?.get('key')).toBe(FAKE.textbeltKey);
  });

  it('surfaces error and quotaRemaining when success is false', async () => {
    stubFetchJson(200, { success: false, error: 'Out of quota', quotaRemaining: 0 });
    expect(await textbelt.send({ phone: PHONE }, MESSAGE, makeEnv())).toEqual({
      ok: false,
      error: 'textbelt: Out of quota (quotaRemaining: 0)',
    });
  });

  it('reports the HTTP status when the body has no error field', async () => {
    stubFetch(() => new Response('gateway error', { status: 503 }));
    expect(await textbelt.send({ phone: PHONE }, MESSAGE, makeEnv())).toEqual({ ok: false, error: 'textbelt: http 503' });
  });

  it('times out and maps network failures', async () => {
    stubFetchHang();
    expect(await textbelt.send({ phone: PHONE }, MESSAGE, makeEnv(), SHORT)).toEqual({ ok: false, error: 'textbelt: timed out' });
    stubFetchNetworkError();
    expect(await textbelt.send({ phone: PHONE }, MESSAGE, makeEnv())).toEqual({ ok: false, error: 'textbelt: unreachable' });
  });

  it('never calls out without a phone number', async () => {
    const stub = stubFetchJson(200, { success: true });
    expect(await textbelt.send({ telegramChatId: CHAT_ID }, MESSAGE, makeEnv())).toEqual({
      ok: false,
      error: 'contact has no phone number',
    });
    expect(stub.mock).not.toHaveBeenCalled();
  });
});

describe('twilio adapter', () => {
  it('is configured only when all three variables are present', () => {
    expect(twilio.configured(makeEnv())).toBe(false);
    expect(twilio.configured(makeEnv({ TWILIO_ACCOUNT_SID: FAKE.twilioSid, TWILIO_AUTH_TOKEN: FAKE.twilioToken }))).toBe(false);
    expect(twilio.configured(makeEnv({ TWILIO_ACCOUNT_SID: FAKE.twilioSid, TWILIO_FROM: FAKE.twilioFrom }))).toBe(false);
    expect(twilio.configured(makeEnv({ TWILIO_AUTH_TOKEN: FAKE.twilioToken, TWILIO_FROM: FAKE.twilioFrom }))).toBe(false);
    expect(twilio.configured(fullEnv())).toBe(true);
  });

  it('is skipped with "not configured" and no network call when credentials are missing', async () => {
    const stub = stubFetchJson(201, {});
    expect(await twilio.send({ phone: PHONE }, MESSAGE, makeEnv())).toEqual({ ok: false, error: 'not configured' });
    expect(stub.mock).not.toHaveBeenCalled();
  });

  it('POSTs the Messages resource with Basic auth and a form body', async () => {
    const stub = stubFetchJson(201, { sid: 'SMtest', status: 'queued' });
    const result = await twilio.send({ phone: PHONE }, MESSAGE, fullEnv());

    expect(result).toEqual({ ok: true });
    const call = stub.calls[0]!;
    expect(call.url).toBe(`${TWILIO_API_BASE}/Accounts/${FAKE.twilioSid}/Messages.json`);
    expect(call.init.method).toBe('POST');
    expect(new Headers(call.init.headers).get('Authorization')).toBe(`Basic ${btoa(`${FAKE.twilioSid}:${FAKE.twilioToken}`)}`);
    expect(call.form?.get('To')).toBe(PHONE);
    expect(call.form?.get('From')).toBe(FAKE.twilioFrom);
    expect(call.form?.get('Body')).toBe(MESSAGE);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports the Twilio error code and message on an HTTP error', async () => {
    stubFetchJson(400, { code: 21211, message: "The 'To' number is not a valid phone number.", status: 400 });
    expect(await twilio.send({ phone: PHONE }, MESSAGE, fullEnv())).toEqual({
      ok: false,
      error: "twilio 400 [21211]: The 'To' number is not a valid phone number.",
    });
  });

  it('times out and maps network failures', async () => {
    stubFetchHang();
    expect(await twilio.send({ phone: PHONE }, MESSAGE, fullEnv(), SHORT)).toEqual({ ok: false, error: 'twilio: timed out' });
    stubFetchNetworkError();
    expect(await twilio.send({ phone: PHONE }, MESSAGE, fullEnv())).toEqual({ ok: false, error: 'twilio: unreachable' });
  });
});

describe('fcm stub', () => {
  it('is never configured and returns the part-2 marker without calling out', async () => {
    const stub = stubFetchJson(200, {});
    expect(fcm.configured(fullEnv())).toBe(false);
    expect(fcm.applicable({ pushToken: 'ExponentPushToken[abc]' })).toBe(true);
    expect(fcm.applicable({ phone: PHONE })).toBe(false);
    expect(await fcm.send({ pushToken: 'ExponentPushToken[abc]' }, MESSAGE, fullEnv())).toEqual({
      ok: false,
      error: FCM_NOT_IMPLEMENTED,
    });
    expect(stub.mock).not.toHaveBeenCalled();
  });
});
