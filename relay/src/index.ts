/**
 * PHC emergency alert relay — Cloudflare Worker entry point.
 *
 *   POST /sos               deliver one alert to one contact over the configured channels
 *   POST /link              redeem a Telegram link token for a chat id (one-time; 404 until tapped)
 *   POST /telegram/webhook  Telegram bot updates (`/start <linkToken>` → chat id stored)
 *   GET  /health            liveness + which adapters are configured (no secrets)
 *
 * The phone knows this Worker's URL and nothing else; every provider credential lives in the
 * Worker environment. The URL is public by design — see docs/features/sos-relay.md for the abuse
 * model — so `/sos` and `/link` sit behind a shared app key (optional for free channels,
 * **required** once a paid SMS channel is configured) and a per-IP rate limit, and the webhook
 * refuses to run without its secret. Misconfiguration fails closed with a 503, never open.
 *
 * Nothing in this file logs a request body, a phone number or a chat id.
 */

import { fcm } from './adapters/fcm';
import { telegram } from './adapters/telegram';
import { textbelt } from './adapters/textbelt';
import { twilio } from './adapters/twilio';
import type { SendOptions } from './adapters/types';
import { MAX_BODY_BYTES, parseChannelOrder, validateLinkRequest, validateSosRequest } from './contract';
import { type AdapterMap, configuredChannels, dispatch, type DispatchOptions } from './dispatch';
import { appKeySet, type Env, flag, paidSmsConfigured, positiveInt, webhookSecretSet } from './env';
import { handleTelegramUpdate, type LinkStore, redeemLink } from './link';
import { clientKey, RateLimiter } from './ratelimit';

export const ADAPTERS: AdapterMap = { telegram, textbelt, twilio, fcm };

export const APP_KEY_HEADER = 'X-PHC-Key';
export const TELEGRAM_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const RATE_WINDOW_MS = 60_000;

export interface HandlerDeps {
  readonly adapters?: AdapterMap;
  /** Shared across requests; the default export keeps one per isolate. */
  readonly limiter?: RateLimiter;
  readonly dispatchOptions?: DispatchOptions;
  readonly sendOptions?: SendOptions;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Length-independent-ish equality so the app key cannot be guessed byte by byte from timing. */
export function safeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

type ParsedBody = { ok: true; body: unknown } | { ok: false; response: Response };

/** Size-capped JSON body. The cap is checked on the header before any bytes are parsed. */
async function parseJsonBody(request: Request): Promise<ParsedBody> {
  const declared = Number.parseInt(request.headers.get('Content-Length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: json(413, { error: `body must be at most ${MAX_BODY_BYTES} bytes` }) };
  }
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return { ok: false, response: json(413, { error: `body must be at most ${MAX_BODY_BYTES} bytes` }) };
    }
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: json(400, { error: 'body must be JSON' }) };
  }
}

/** Build the fetch handler with injectable pieces. The default export wires the real ones. */
export function createHandler(deps: HandlerDeps = {}) {
  const adapters = deps.adapters ?? ADAPTERS;
  let limiter = deps.limiter;

  const limiterFor = (env: Env): RateLimiter => {
    if (limiter === undefined) {
      limiter = new RateLimiter({ limit: positiveInt(env.RATE_LIMIT_PER_MINUTE, 10), windowMs: RATE_WINDOW_MS });
    }
    return limiter;
  };

  /** Shared gate for the two app-facing endpoints. Returns a response to send, or null to proceed. */
  const gate = (request: Request, env: Env): Response | null => {
    // Fail closed: a leaked public URL must never be able to spend money. Free channels
    // (Telegram, free-tier Textbelt) may run without a key; a paid SMS channel may not.
    if (!appKeySet(env) && paidSmsConfigured(env)) {
      return json(503, { error: 'RELAY_APP_KEY required when a paid SMS channel is configured' });
    }
    if (appKeySet(env)) {
      const presented = request.headers.get(APP_KEY_HEADER) ?? '';
      if (!safeEqual(presented, env.RELAY_APP_KEY ?? '')) return json(401, { error: 'invalid app key' });
    }
    if (!limiterFor(env).allow(clientKey(request))) {
      return json(429, { error: 'rate limited' });
    }
    return null;
  };

  return async function fetchHandler(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/health') {
        if (request.method !== 'GET') return json(405, { error: 'method not allowed' });
        const botUsername = env.BOT_USERNAME?.trim().replace(/^@/, '') ?? '';
        return json(200, {
          ok: true,
          service: 'phc-sos-relay',
          channels: configuredChannels(adapters, env),
          channelOrder: parseChannelOrder(env.CHANNEL_ORDER),
          smsAlways: flag(env.SMS_ALWAYS, true),
          // Misconfiguration is visible here so a deploy can be checked before the first alert.
          appKeyRequired: paidSmsConfigured(env),
          appKeySet: appKeySet(env),
          webhookSecured: webhookSecretSet(env),
          linking: typeof env.LINKS === 'object' && env.LINKS !== null,
          botUsername: botUsername.length > 0 ? botUsername : null,
        });
      }

      if (path === '/sos') {
        if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
        const denied = gate(request, env);
        if (denied !== null) return denied;

        const parsed = await parseJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const validated = validateSosRequest(parsed.body);
        if (!validated.ok) return json(400, { error: validated.error });

        const response = await dispatch(validated.value, adapters, env, {
          ...deps.dispatchOptions,
          ...deps.sendOptions,
        });
        // 502 when nothing got through: the app's client treats any non-2xx as "fall back to the
        // SMS composer", which is exactly the right thing when the relay could not deliver.
        return json(response.delivered ? 200 : 502, response);
      }

      if (path === '/link') {
        if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
        const denied = gate(request, env);
        if (denied !== null) return denied;

        const parsed = await parseJsonBody(request);
        if (!parsed.ok) return parsed.response;
        const validated = validateLinkRequest(parsed.body);
        if (!validated.ok) return json(400, { error: validated.error });

        // 404 until the caregiver taps the deep link; the app polls. One-time on success.
        const chatId = await redeemLink(linkStore(env), validated.value.linkToken);
        if (chatId === null) return json(404, { error: 'not linked yet, expired or already used' });
        return json(200, { telegramChatId: chatId });
      }

      if (path === '/telegram/webhook') {
        if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
        // Fail closed: without a secret anyone could POST forged `/start` updates and have the
        // bot message arbitrary chats. The runbook makes `setWebhook … secret_token=` mandatory.
        if (!webhookSecretSet(env)) return json(503, { error: 'webhook secret not configured' });
        const presented = request.headers.get(TELEGRAM_SECRET_HEADER) ?? '';
        if (!safeEqual(presented, env.TELEGRAM_WEBHOOK_SECRET ?? '')) {
          return json(401, { error: 'invalid webhook secret' });
        }

        const parsed = await parseJsonBody(request);
        if (!parsed.ok) return parsed.response;

        const outcome = await handleTelegramUpdate(parsed.body, env, linkStore(env), deps.sendOptions ?? {});
        // Always 2xx once authenticated: Telegram retries non-2xx. The outcome kind is safe to
        // return; it names no chat id and no token.
        return json(200, { ok: true, handled: outcome.kind });
      }

      return json(404, { error: 'not found' });
    } catch (cause) {
      // Name only — an error message could carry a fragment of the body.
      console.error('relay: unhandled error', cause instanceof Error ? cause.name : 'unknown');
      return json(500, { error: 'internal error' });
    }
  };
}

function linkStore(env: Env): LinkStore {
  if (typeof env.LINKS !== 'object' || env.LINKS === null) {
    throw new Error('LINKS KV binding is missing');
  }
  return env.LINKS;
}

const handler = createHandler();

export default {
  fetch: (request, env) => handler(request, env),
} satisfies ExportedHandler<Env>;
