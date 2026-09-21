/**
 * Telegram Bot API adapter — the primary automatic path whenever the phone has data.
 *
 * Free and unlimited; needs only a bot token from @BotFather. The contact must have linked their
 * chat with the bot once (src/link.ts) because a bot can only message chats that opened it first —
 * that constraint is Telegram's anti-spam rule and the reason the link flow exists.
 *
 * API: https://core.telegram.org/bots/api#sendmessage
 */

import type { Destination } from '../contract';
import type { Env } from '../env';
import { describe, readJson, upstream, type Adapter, type SendOptions, type SendResult } from './types';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

export function telegramApiUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

/** Low-level sendMessage, shared with the link webhook's replies. */
export async function telegramSendMessage(
  token: string,
  chatId: string,
  text: string,
  options?: SendOptions,
): Promise<SendResult> {
  const result = await upstream('telegram', telegramApiUrl(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  }, options);
  if ('error' in result) return { ok: false, error: result.error };

  const body = await readJson(result.response);
  if (result.response.ok && body?.['ok'] === true) return { ok: true };

  const description = describe(body, 'description') ?? 'unexpected response';
  return { ok: false, error: `telegram ${result.response.status}: ${description}` };
}

export const telegram: Adapter = {
  name: 'telegram',
  kind: 'data',
  notConfiguredError: 'not configured',
  notApplicableError: 'contact has no telegramChatId',
  configured: (env: Env) => typeof env.TELEGRAM_BOT_TOKEN === 'string' && env.TELEGRAM_BOT_TOKEN.length > 0,
  applicable: (to: Destination) => typeof to.telegramChatId === 'string',
  async send(to, message, env, options) {
    if (!this.configured(env) || env.TELEGRAM_BOT_TOKEN === undefined) {
      return { ok: false, error: this.notConfiguredError };
    }
    if (to.telegramChatId === undefined) return { ok: false, error: this.notApplicableError };
    return telegramSendMessage(env.TELEGRAM_BOT_TOKEN, to.telegramChatId, message, options);
  },
};
