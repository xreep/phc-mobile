/**
 * Telegram chat-id linking, app side (ADR-007; relay counterpart in `relay/src/link.ts`).
 *
 * A bot may only message a chat that opened it first, so an emergency contact has to do one
 * thing once: tap a link. This module makes that link and redeems it.
 *
 * ## The token is made here, not by the bot
 * The app draws 16 bytes from the platform CSPRNG and base64url-encodes them (22 characters,
 * exactly the relay's `LINK_TOKEN` pattern). It shows the caregiver
 * `https://t.me/<bot>?start=<token>`; Telegram delivers `/start <token>` to the relay's
 * webhook, which stores `token → chat id` for ten minutes; the app polls `POST /link` until
 * the chat id is there. A six-digit code the caregiver reads out would be 10^6 guesses in a
 * ten-minute window and a per-IP rate limit does not make that safe — see the relay's
 * `link.ts` header. 128 bits from the phone is not guessable in any window, and only the
 * caregiver's Telegram client ever sees it.
 *
 * `getRandomValues` is the `expo-crypto` entry point documented as cryptographically secure
 * (https://docs.expo.dev/versions/v57.0.0/sdk/crypto/). `getRandomBytes` is documented as
 * falling back to `Math.random` in development, which is exactly the wrong property for a
 * token whose unguessability is the whole design, so it is not used.
 *
 * ## Why the poll is every 10 s
 * The relay's per-IP token bucket is 10 requests a minute, shared between `/link` and `/sos`
 * (`relay/src/index.ts`). Six polls a minute leaves four for an SOS that fires while a link is
 * pending; every 5 s would leave none and the emergency call would answer 429. Ten minutes is
 * the relay's KV TTL (`LINK_TTL_SECONDS`): polling past it can only ever see 404.
 *
 * Nothing about the PHC user crosses this flow — no phone number, no name, no health data. The
 * relay learns a chat id Telegram already knows; the app learns the same chat id. Nothing here
 * logs.
 */

import { getRandomValues } from 'expo-crypto';

import {
  RELAY_APP_KEY_HEADER,
  RELAY_TIMEOUT_MS,
  resolveRelayAppKey,
  resolveRelayEndpoint,
  resolveRelayRoute,
} from './config';
import { describeRelayStatus, RELAY_NOT_CONFIGURED_ERROR } from './relay';

/** 128 bits. */
export const LINK_TOKEN_BYTES = 16;

/** Same regex as the relay's `LINK_TOKEN` (`relay/src/contract.ts`). */
export const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Poll cadence — see the module header for why not faster. */
export const LINK_POLL_INTERVAL_MS = 10_000;

/** Give up after the relay's own TTL; the token is dead by then either way. */
export const LINK_POLL_TIMEOUT_MS = 10 * 60_000;

/** Telegram chat ids are 64-bit integers; groups and channels are negative. Same as the relay. */
const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Unpadded base64url of `bytes`.
 *
 * Hand-rolled because neither `Buffer` nor `btoa` is a given on Hermes, and a 16-byte input is
 * small enough that a table lookup is clearer than a polyfill. 16 bytes → 22 characters (the
 * last group is two bytes, so two characters of the final quartet are dropped with the padding).
 */
function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64URL[(triple >> 18) & 63];
    out += BASE64URL[(triple >> 12) & 63];
    if (b !== undefined) out += BASE64URL[(triple >> 6) & 63];
    if (c !== undefined) out += BASE64URL[triple & 63];
  }
  return out;
}

/**
 * A fresh link token.
 *
 * `randomImpl` exists so a test can pin the encoding against known bytes; production always
 * uses the CSPRNG.
 */
export function generateLinkToken(
  randomImpl: (array: Uint8Array) => Uint8Array = getRandomValues,
): string {
  return base64url(randomImpl(new Uint8Array(LINK_TOKEN_BYTES)));
}

/** Build the deep link the caregiver taps. Mirrors the relay's `telegramDeepLink`. */
export function telegramDeepLink(botUsername: string, linkToken: string): string {
  return `https://t.me/${botUsername.replace(/^@/, '')}?start=${linkToken}`;
}

/** The sentence shown under the link, including the manual recovery. */
export function telegramLinkInstructions(botUsername: string, linkToken: string): string {
  const bot = botUsername.replace(/^@/, '');
  return (
    'Send this link to the contact. They tap it in Telegram and press Start. ' +
    `If Telegram does not show the code, they can send /start ${linkToken} to @${bot}.`
  );
}

export function isTelegramChatId(value: string): boolean {
  return TELEGRAM_CHAT_ID.test(value);
}

/** A stored or received chat id, trimmed, or undefined when it cannot be one. */
export function normalizeTelegramChatId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return isTelegramChatId(trimmed) ? trimmed : undefined;
}

export type RelayCallOptions = {
  readonly fetchImpl?: typeof fetch;
  /** Overrides the configured `/sos` endpoint (siblings are derived from it). Tests only. */
  readonly endpoint?: string | null;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
};

export type BotUsernameResult =
  | { readonly ok: true; readonly botUsername: string }
  | { readonly ok: false; readonly error: string; readonly notConfigured?: boolean };

export type RedeemResult =
  /** The caregiver has not tapped yet (404). Keep polling. */
  | { readonly status: 'pending' }
  /** A transient failure (429, 5xx, network). The token is still good; keep polling. */
  | { readonly status: 'retry' }
  | { readonly status: 'linked'; readonly telegramChatId: string }
  /** Will not change by waiting (no relay, 401, 400, unusable chat id). */
  | { readonly status: 'failed'; readonly error: string };

const NOT_LINKABLE = 'This relay is not set up for Telegram linking.';

type Fetched = { readonly ok: true; readonly response: Response } | { readonly ok: false; readonly aborted: boolean };

/** One fetch with the relay timeout and the optional app key, never throwing. */
async function callRelay(
  url: string,
  init: RequestInit,
  options: RelayCallOptions,
): Promise<Fetched> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RELAY_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers as Record<string, string>) };
  const appKey = resolveRelayAppKey();
  if (appKey !== null) headers[RELAY_APP_KEY_HEADER] = appKey;

  try {
    const response = await doFetch(url, { ...init, headers, signal: controller.signal });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, aborted: error instanceof Error && error.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = typeof response.json === 'function' ? await response.json() : null;
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `GET /health` → the bot's username, or why linking is not possible on this deployment.
 *
 * `/health` carries no secrets and needs no key; it is the same page the runbook checks a deploy
 * with. `botUsername: null` means `BOT_USERNAME` is unset; `linking: false` means the KV binding
 * is missing. Either way a deep link would lead nowhere, so both are "not linkable".
 */
export async function fetchRelayBotUsername(options: RelayCallOptions = {}): Promise<BotUsernameResult> {
  const endpoint = options.endpoint === undefined ? resolveRelayEndpoint() : options.endpoint;
  const url = resolveRelayRoute('health', endpoint);
  if (url === null) return { ok: false, notConfigured: true, error: RELAY_NOT_CONFIGURED_ERROR };

  const fetched = await callRelay(url, { method: 'GET' }, options);
  if (!fetched.ok) {
    return { ok: false, error: fetched.aborted ? 'The SOS relay timed out.' : 'Could not reach the SOS relay.' };
  }
  if (!fetched.response.ok) return { ok: false, error: describeRelayStatus(fetched.response.status) };

  const body = await readJson(fetched.response);
  const botUsername = typeof body?.botUsername === 'string' ? body.botUsername.trim().replace(/^@/, '') : '';
  if (botUsername.length === 0 || body?.linking !== true) return { ok: false, error: NOT_LINKABLE };
  return { ok: true, botUsername };
}

/**
 * `POST /link { linkToken }` — one poll.
 *
 * The relay answers 404 until the caregiver taps, then `{ telegramChatId }` once. The result
 * says whether to keep polling, so the hook that drives the cadence holds no HTTP knowledge.
 */
export async function redeemLinkToken(
  linkToken: string,
  options: RelayCallOptions = {},
): Promise<RedeemResult> {
  const endpoint = options.endpoint === undefined ? resolveRelayEndpoint() : options.endpoint;
  const url = resolveRelayRoute('link', endpoint);
  if (url === null) return { status: 'failed', error: RELAY_NOT_CONFIGURED_ERROR };

  const fetched = await callRelay(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ linkToken }),
    },
    options,
  );
  if (!fetched.ok) return { status: 'retry' };

  const { status } = fetched.response;
  if (status === 404) return { status: 'pending' };
  if (status === 429 || status >= 500) return { status: 'retry' };
  if (!fetched.response.ok) return { status: 'failed', error: describeRelayStatus(status) };

  const body = await readJson(fetched.response);
  const telegramChatId = normalizeTelegramChatId(body?.telegramChatId);
  if (telegramChatId === undefined) {
    return { status: 'failed', error: 'The SOS relay returned an unusable chat id.' };
  }
  return { status: 'linked', telegramChatId };
}
