import { describe, expect, it } from 'vitest';

import { MAX_MESSAGE_LENGTH, parseChannelOrder, validateLinkRequest, validateSosRequest } from '../src/contract';
import { CHAT_ID, MESSAGE, PHONE } from './helpers/env';

describe('validateSosRequest', () => {
  it('accepts the legacy { to: "<phone>", message } body the current app sends', () => {
    const result = validateSosRequest({ to: PHONE, message: MESSAGE });
    expect(result).toEqual({
      ok: true,
      value: { to: { phone: PHONE }, message: MESSAGE, channels: undefined, legacy: true },
    });
  });

  it('accepts the structured body with every destination field and channels', () => {
    const result = validateSosRequest({
      to: { phone: PHONE, telegramChatId: CHAT_ID, pushToken: 'ExponentPushToken[abc]' },
      message: MESSAGE,
      channels: ['telegram', 'textbelt'],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        to: { phone: PHONE, telegramChatId: CHAT_ID, pushToken: 'ExponentPushToken[abc]' },
        message: MESSAGE,
        channels: ['telegram', 'textbelt'],
        legacy: false,
      },
    });
  });

  it('passes the message through verbatim, whitespace and all', () => {
    const message = '  two  spaces\nand a newline  ';
    const result = validateSosRequest({ to: PHONE, message });
    expect(result.ok && result.value.message).toBe(message);
  });

  it.each([
    ['not an object', 'body must be a JSON object'],
    [null, 'body must be a JSON object'],
    [[], 'body must be a JSON object'],
    [{ to: PHONE }, 'message must be a non-empty string'],
    [{ to: PHONE, message: '   ' }, 'message must be a non-empty string'],
    [{ to: PHONE, message: 42 }, 'message must be a non-empty string'],
    [{ to: PHONE, message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }, `message must be at most ${MAX_MESSAGE_LENGTH} characters`],
    [{ message: MESSAGE }, 'to must be an E.164 string or an object'],
    [{ to: '9876543210', message: MESSAGE }, 'to must be an E.164 phone number'],
    [{ to: '+0123', message: MESSAGE }, 'to must be an E.164 phone number'],
    [{ to: {}, message: MESSAGE }, 'to needs at least one of phone, telegramChatId, pushToken'],
    [{ to: { phone: '', telegramChatId: ' ' }, message: MESSAGE }, 'to needs at least one of phone, telegramChatId, pushToken'],
    [{ to: { phone: '98765' }, message: MESSAGE }, 'to.phone is not in the expected format'],
    [{ to: { phone: 12345 }, message: MESSAGE }, 'to.phone must be a string'],
    [{ to: { telegramChatId: 'abc' }, message: MESSAGE }, 'to.telegramChatId is not in the expected format'],
    [{ to: { pushToken: 'x'.repeat(5000) }, message: MESSAGE }, 'to.pushToken is too long'],
    [{ to: PHONE, message: MESSAGE, channels: 'telegram' }, 'channels must be an array of strings'],
    [{ to: PHONE, message: MESSAGE, channels: [1] }, 'channels must be an array of strings'],
  ])('rejects %j', (body, error) => {
    expect(validateSosRequest(body)).toEqual({ ok: false, error });
  });

  it('trims and accepts a negative (group) telegram chat id', () => {
    const result = validateSosRequest({ to: { telegramChatId: ' -1001234567890 ' }, message: MESSAGE });
    expect(result).toEqual({
      ok: true,
      value: { to: { telegramChatId: '-1001234567890' }, message: MESSAGE, channels: undefined, legacy: false },
    });
  });

  it('drops unknown channel names, dedupes, and treats an all-unknown list as no preference', () => {
    const known = validateSosRequest({ to: PHONE, message: MESSAGE, channels: ['Telegram', 'msg91', 'telegram', 'twilio'] });
    expect(known.ok && known.value.channels).toEqual(['telegram', 'twilio']);

    const unknown = validateSosRequest({ to: PHONE, message: MESSAGE, channels: ['msg91', 'whatsapp'] });
    expect(unknown.ok && unknown.value.channels).toBeUndefined();

    const empty = validateSosRequest({ to: PHONE, message: MESSAGE, channels: [] });
    expect(empty.ok && empty.value.channels).toBeUndefined();
  });
});

describe('validateLinkRequest', () => {
  it('accepts six digits as a string or a number', () => {
    expect(validateLinkRequest({ code: '012345' })).toEqual({ ok: true, value: { code: '012345' } });
    expect(validateLinkRequest({ code: ' 987654 ' })).toEqual({ ok: true, value: { code: '987654' } });
    expect(validateLinkRequest({ code: 123456 })).toEqual({ ok: true, value: { code: '123456' } });
  });

  it.each([[{}], [{ code: '12345' }], [{ code: '1234567' }], [{ code: 'abcdef' }], [{ code: null }], ['nope']])(
    'rejects %j',
    (body) => {
      const result = validateLinkRequest(body);
      expect(result.ok).toBe(false);
    },
  );
});

describe('parseChannelOrder', () => {
  it('parses, trims, lowercases, dedupes and drops unknown names', () => {
    expect(parseChannelOrder(' Telegram, textbelt ,nope,telegram,fcm')).toEqual(['telegram', 'textbelt', 'fcm']);
    expect(parseChannelOrder(undefined)).toEqual([]);
    expect(parseChannelOrder('')).toEqual([]);
  });
});
