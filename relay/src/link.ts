/**
 * Telegram chat-id linking.
 *
 * A bot may only message a chat that opened it first, so the caregiver has to do one thing once:
 * open the bot and send `/start`. Telegram calls our webhook, we mint a six-digit code, store
 * `code → chat_id` in KV for ten minutes and reply with the code. The caregiver reads it out; the
 * PHC user types it into the app; the app calls `POST /link { code }` and gets the chat id to store
 * in the contact. The code is one-time: `/link` deletes it on success.
 *
 * Nothing about the PHC user crosses this flow — no phone number, no name, no health data. The bot
 * learns a chat id (which Telegram already knows) and the app learns the same chat id.
 *
 * Webhook reference: https://core.telegram.org/bots/api#setwebhook — the `secret_token` given to
 * setWebhook arrives on every update as `X-Telegram-Bot-Api-Secret-Token`.
 */

import { telegramSendMessage } from './adapters/telegram';
import type { SendOptions } from './adapters/types';
import type { Env } from './env';

/** The subset of `KVNamespace` this module uses — a fake in tests, the real binding in prod. */
export interface LinkStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** KV requires a TTL of at least 60 s; ten minutes is long enough to read a code out loud. */
export const LINK_TTL_SECONDS = 600;
const KEY_PREFIX = 'link:';
const CODE_ATTEMPTS = 5;

export const START_HELP =
  'Send /start to get a link code. Once linked, this chat receives emergency alerts from the PHC app.';

export function linkCodeMessage(code: string): string {
  return `Your PHC link code is ${code} — enter it in the PHC app under Emergency contacts. Expires in 10 minutes.`;
}

/** Six random digits from the runtime CSPRNG, zero-padded. */
export function randomCode(random: (max: number) => number = cryptoRandomBelow): string {
  return String(random(1_000_000)).padStart(6, '0');
}

function cryptoRandomBelow(max: number): number {
  // Rejection sampling keeps the distribution uniform; 2^32 mod 1e6 is tiny but nonzero.
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] ?? 0;
    if (value < limit) return value % max;
  }
}

/**
 * Mint and store a code for `chatId`. Retries on the (rare) collision with a live code so two
 * caregivers linking in the same ten minutes can never be handed the same digits.
 */
export async function createLinkCode(
  store: LinkStore,
  chatId: string,
  random?: (max: number) => number,
): Promise<string> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
    const code = randomCode(random);
    if ((await store.get(KEY_PREFIX + code)) !== null) continue;
    await store.put(KEY_PREFIX + code, chatId, { expirationTtl: LINK_TTL_SECONDS });
    return code;
  }
  throw new Error('could not allocate a link code');
}

/** Exchange a code for its chat id, consuming it. `null` when unknown, expired or already used. */
export async function redeemLinkCode(store: LinkStore, code: string): Promise<string | null> {
  const key = KEY_PREFIX + code;
  const chatId = await store.get(key);
  if (chatId === null) return null;
  await store.delete(key);
  return chatId;
}

// ---- webhook ----

/** The parts of a Telegram `Update` this relay looks at. Everything else is ignored. */
export interface TelegramUpdate {
  readonly message?: {
    readonly text?: string;
    readonly chat?: { readonly id?: number | string; readonly type?: string };
  };
}

export type WebhookOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'help'; readonly chatId: string }
  | { readonly kind: 'code'; readonly chatId: string; readonly code: string };

/**
 * Handle one update. Returns what happened so the router can answer 200 and tests can assert on it
 * without parsing bot replies. Replies are sent with the bot's own sendMessage; a failed reply is
 * swallowed (Telegram would otherwise retry the update and mint a second code).
 */
export async function handleTelegramUpdate(
  update: unknown,
  env: Env,
  store: LinkStore,
  options: SendOptions & { random?: (max: number) => number } = {},
): Promise<WebhookOutcome> {
  const message = isUpdate(update) ? update.message : undefined;
  const chatIdRaw = message?.chat?.id;
  const chatId = typeof chatIdRaw === 'number' || typeof chatIdRaw === 'string' ? String(chatIdRaw) : undefined;
  const text = typeof message?.text === 'string' ? message.text.trim() : '';
  if (chatId === undefined || text.length === 0) return { kind: 'ignored' };

  const token = env.TELEGRAM_BOT_TOKEN;
  if (token === undefined || token.length === 0) return { kind: 'ignored' };
  const sendOptions: SendOptions = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };

  // `/start` and `/start <payload>` (deep links) both count; anything else gets the help line.
  if (/^\/start(@\w+)?(\s|$)/.test(text)) {
    const code = await createLinkCode(store, chatId, options.random);
    await telegramSendMessage(token, chatId, linkCodeMessage(code), sendOptions);
    return { kind: 'code', chatId, code };
  }

  await telegramSendMessage(token, chatId, START_HELP, sendOptions);
  return { kind: 'help', chatId };
}

function isUpdate(value: unknown): value is TelegramUpdate {
  return typeof value === 'object' && value !== null;
}
