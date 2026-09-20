import { describe, expect, it } from 'vitest';

import type { Adapter, SendResult } from '../src/adapters/types';
import type { ChannelName, SosRequest } from '../src/contract';
import { type AdapterMap, configuredChannels, dispatch, planChannels } from '../src/dispatch';
import { CHAT_ID, makeEnv, MESSAGE, PHONE } from './helpers/env';

/** A scripted adapter: records what it was asked to send and answers from a queue. */
function fake(
  name: ChannelName,
  kind: Adapter['kind'],
  options: { configured?: boolean; needs: 'phone' | 'telegramChatId' | 'pushToken'; results?: SendResult[] } ,
): Adapter & { sent: string[] } {
  const queue = [...(options.results ?? [{ ok: true }])];
  const adapter: Adapter & { sent: string[] } = {
    name,
    kind,
    sent: [],
    notConfiguredError: name === 'fcm' ? 'not implemented (M5 part 2)' : 'not configured',
    notApplicableError: `contact has no ${options.needs}`,
    configured: () => options.configured ?? true,
    applicable: (to) => to[options.needs] !== undefined,
    async send(_to, message) {
      adapter.sent.push(message);
      return queue.shift() ?? { ok: false, error: 'queue empty' };
    },
  };
  return adapter;
}

type Fakes = { [K in ChannelName]: Adapter & { sent: string[] } };

function fakes(overrides: Partial<{ [K in ChannelName]: Parameters<typeof fake>[2] }> = {}): Fakes {
  return {
    telegram: fake('telegram', 'data', { needs: 'telegramChatId', ...overrides.telegram }),
    textbelt: fake('textbelt', 'sms', { needs: 'phone', ...overrides.textbelt }),
    twilio: fake('twilio', 'sms', { needs: 'phone', configured: false, ...overrides.twilio }),
    fcm: fake('fcm', 'data', { needs: 'pushToken', configured: false, ...overrides.fcm }),
  };
}

function request(overrides: Partial<SosRequest> = {}): SosRequest {
  return { to: { phone: PHONE, telegramChatId: CHAT_ID }, message: MESSAGE, channels: undefined, legacy: false, ...overrides };
}

describe('planChannels', () => {
  it('uses CHANNEL_ORDER when the request names no channels', () => {
    expect(planChannels(request(), fakes(), makeEnv({ CHANNEL_ORDER: 'textbelt,telegram' }))).toEqual(['textbelt', 'telegram']);
  });

  it('uses the requested order when at least one requested channel is configured', () => {
    expect(planChannels(request({ channels: ['textbelt', 'telegram'] }), fakes(), makeEnv())).toEqual(['textbelt', 'telegram']);
  });

  it('falls back to CHANNEL_ORDER when nothing requested is configured', () => {
    expect(planChannels(request({ channels: ['fcm', 'twilio'] }), fakes(), makeEnv())).toEqual(['telegram', 'textbelt']);
  });

  it('appends the preferred configured SMS adapter under SMS_ALWAYS when the plan has none', () => {
    const adapters = fakes();
    expect(planChannels(request({ channels: ['telegram'] }), adapters, makeEnv())).toEqual(['telegram', 'textbelt']);
    // Textbelt preferred; twilio only when textbelt is not configured.
    const twilioOnly = fakes({ textbelt: { needs: 'phone', configured: false }, twilio: { needs: 'phone', configured: true } });
    expect(planChannels(request({ channels: ['telegram'] }), twilioOnly, makeEnv())).toEqual(['telegram', 'twilio']);
  });

  it('does not append SMS without a phone number or with SMS_ALWAYS=false', () => {
    expect(planChannels(request({ to: { telegramChatId: CHAT_ID }, channels: ['telegram'] }), fakes(), makeEnv())).toEqual(['telegram']);
    expect(planChannels(request({ channels: ['telegram'] }), fakes(), makeEnv({ SMS_ALWAYS: 'false' }))).toEqual(['telegram']);
  });

  it('yields an empty plan when CHANNEL_ORDER is empty and nothing is requested', () => {
    expect(planChannels(request({ to: { telegramChatId: CHAT_ID } }), fakes(), makeEnv({ CHANNEL_ORDER: '' }))).toEqual([]);
  });
});

describe('dispatch', () => {
  it('reports delivered when the first channel succeeds and still sends one SMS (SMS_ALWAYS default)', async () => {
    const adapters = fakes();
    const response = await dispatch(request(), adapters, makeEnv());

    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(adapters.telegram.sent).toEqual([MESSAGE]);
    expect(adapters.textbelt.sent).toEqual([MESSAGE]);
  });

  it('stops after the first success when SMS_ALWAYS is off', async () => {
    const adapters = fakes();
    const response = await dispatch(request(), adapters, makeEnv({ SMS_ALWAYS: 'false' }));
    expect(response).toEqual({ delivered: true, results: [{ channel: 'telegram', ok: true }] });
    expect(adapters.textbelt.sent).toEqual([]);
  });

  it('attempts exactly one SMS adapter after a data success even if it fails', async () => {
    const adapters = fakes({
      textbelt: { needs: 'phone', results: [{ ok: false, error: 'textbelt: Out of quota' }] },
      twilio: { needs: 'phone', configured: true },
    });
    const response = await dispatch(request(), adapters, makeEnv({ CHANNEL_ORDER: 'telegram,textbelt,twilio' }));

    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: true },
        { channel: 'textbelt', ok: false, error: 'textbelt: Out of quota' },
      ],
    });
    expect(adapters.twilio.sent).toEqual([]);
  });

  it('falls through every channel when there is no success yet, then reports 502-worthy failure', async () => {
    const adapters = fakes({
      telegram: { needs: 'telegramChatId', results: [{ ok: false, error: 'telegram: timed out' }] },
      textbelt: { needs: 'phone', results: [{ ok: false, error: 'textbelt: Out of quota' }] },
      twilio: { needs: 'phone', configured: true, results: [{ ok: false, error: 'twilio 401: bad auth' }] },
    });
    const response = await dispatch(request(), adapters, makeEnv({ CHANNEL_ORDER: 'telegram,textbelt,twilio' }));

    expect(response).toEqual({
      delivered: false,
      results: [
        { channel: 'telegram', ok: false, error: 'telegram: timed out' },
        { channel: 'textbelt', ok: false, error: 'textbelt: Out of quota' },
        { channel: 'twilio', ok: false, error: 'twilio 401: bad auth' },
      ],
    });
  });

  it('a second SMS adapter is tried when the first SMS fails and nothing has been delivered', async () => {
    const adapters = fakes({
      telegram: { needs: 'telegramChatId', results: [{ ok: false, error: 'telegram: unreachable' }] },
      textbelt: { needs: 'phone', results: [{ ok: false, error: 'textbelt: http 503' }] },
      twilio: { needs: 'phone', configured: true },
    });
    const response = await dispatch(request(), adapters, makeEnv({ CHANNEL_ORDER: 'telegram,textbelt,twilio' }));
    expect(response.delivered).toBe(true);
    expect(response.results.map((r) => r.channel)).toEqual(['telegram', 'textbelt', 'twilio']);
  });

  it('an SMS success ends the run before later data channels', async () => {
    const adapters = fakes({ fcm: { needs: 'pushToken', configured: true } });
    const response = await dispatch(
      request({ to: { phone: PHONE, pushToken: 'tok' } }),
      adapters,
      makeEnv({ CHANNEL_ORDER: 'textbelt,fcm' }),
    );
    expect(response).toEqual({ delivered: true, results: [{ channel: 'textbelt', ok: true }] });
    expect(adapters.fcm.sent).toEqual([]);
  });

  it('records not-configured and not-applicable rows without calling those adapters', async () => {
    const adapters = fakes();
    const response = await dispatch(
      request({ to: { phone: PHONE } }),
      adapters,
      makeEnv({ CHANNEL_ORDER: 'fcm,telegram,twilio,textbelt' }),
    );

    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'fcm', ok: false, error: 'not implemented (M5 part 2)' },
        { channel: 'telegram', ok: false, error: 'contact has no telegramChatId' },
        { channel: 'twilio', ok: false, error: 'not configured' },
        { channel: 'textbelt', ok: true },
      ],
    });
    expect(adapters.fcm.sent).toEqual([]);
    expect(adapters.telegram.sent).toEqual([]);
    expect(adapters.twilio.sent).toEqual([]);
  });

  it('legacy body: phone only + CHANNEL_ORDER → telegram skipped, SMS sent', async () => {
    const adapters = fakes();
    const response = await dispatch(request({ to: { phone: PHONE }, legacy: true }), adapters, makeEnv());
    expect(response).toEqual({
      delivered: true,
      results: [
        { channel: 'telegram', ok: false, error: 'contact has no telegramChatId' },
        { channel: 'textbelt', ok: true },
      ],
    });
  });

  it('an empty plan is a clean failure, not an exception', async () => {
    const response = await dispatch(request({ to: { telegramChatId: CHAT_ID } }), fakes(), makeEnv({ CHANNEL_ORDER: '' }));
    expect(response).toEqual({ delivered: false, results: [] });
  });

  it('passes the message through verbatim to every adapter', async () => {
    const adapters = fakes();
    const message = 'PHC EMERGENCY - “quotes”, emoji 🚑, newline\nand trailing space ';
    await dispatch(request({ message }), adapters, makeEnv());
    expect(adapters.telegram.sent).toEqual([message]);
    expect(adapters.textbelt.sent).toEqual([message]);
  });
});

describe('configuredChannels', () => {
  it('reports each adapter without touching the network', () => {
    const adapters: AdapterMap = fakes();
    expect(configuredChannels(adapters, makeEnv())).toEqual({ telegram: true, textbelt: true, twilio: false, fcm: false });
  });
});
