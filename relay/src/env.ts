/**
 * Worker environment: bindings from wrangler.toml plus secrets set with `wrangler secret put`.
 *
 * Everything except `LINKS` is optional on purpose. An adapter whose secrets are missing reports
 * `not configured` instead of throwing, so a deployment with only a Telegram token is a valid,
 * working relay — and one with nothing at all still answers `/health`.
 */
export interface Env {
  /** KV namespace for one-time Telegram link tokens (src/link.ts). */
  LINKS: KVNamespace;

  // ---- [vars] (non-secret, wrangler.toml) ----
  /** Comma-separated channel names tried when the request names none. */
  CHANNEL_ORDER?: string;
  /** The bot's public @username (without @); `/health` exposes it so the app can build the deep link. */
  BOT_USERNAME?: string;
  /** "true" → still attempt one SMS adapter after a data-channel success. */
  SMS_ALWAYS?: string;
  /** Best-effort per-IP token bucket size per minute. */
  RATE_LIMIT_PER_MINUTE?: string;

  // ---- secrets (`wrangler secret put`) ----
  /** Telegram bot token from @BotFather. Enables the `telegram` adapter and the webhook. */
  TELEGRAM_BOT_TOKEN?: string;
  /**
   * Value passed as `secret_token` to setWebhook; verified on every webhook call. Mandatory once
   * a bot token exists: without it the webhook answers 503 rather than accepting forged updates.
   */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Textbelt key. Defaults to "textbelt" (free tier, one message per day per IP). */
  TEXTBELT_KEY?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  /** E.164 sender number owned by the Twilio account. */
  TWILIO_FROM?: string;
  /**
   * Shared key the app sends as `X-PHC-Key`. Raises the bar for drive-by abuse; it ships inside
   * the app bundle, so it is NOT a secret in the cryptographic sense (docs/features/sos-relay.md).
   * Optional for Telegram + free-tier Textbelt; **required** once a paid SMS channel (Twilio, or a
   * paid Textbelt key) is configured — `/sos` answers 503 otherwise, so a leaked URL can never
   * spend money.
   */
  RELAY_APP_KEY?: string;
}

/** Is a channel that costs money per message configured? Drives the app-key requirement. */
export function paidSmsConfigured(env: Env): boolean {
  const textbeltPaid = typeof env.TEXTBELT_KEY === 'string' && env.TEXTBELT_KEY.trim().length > 0;
  const twilio =
    typeof env.TWILIO_ACCOUNT_SID === 'string' && env.TWILIO_ACCOUNT_SID.trim().length > 0 &&
    typeof env.TWILIO_AUTH_TOKEN === 'string' && env.TWILIO_AUTH_TOKEN.trim().length > 0 &&
    typeof env.TWILIO_FROM === 'string' && env.TWILIO_FROM.trim().length > 0;
  return textbeltPaid || twilio;
}

export function appKeySet(env: Env): boolean {
  return typeof env.RELAY_APP_KEY === 'string' && env.RELAY_APP_KEY.length > 0;
}

export function webhookSecretSet(env: Env): boolean {
  return typeof env.TELEGRAM_WEBHOOK_SECRET === 'string' && env.TELEGRAM_WEBHOOK_SECRET.length > 0;
}

/** Parse a "true"/"1"/"yes" style flag; anything else (including unset) is false. */
export function flag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  return /^(true|1|yes|on)$/i.test(value.trim());
}

/** Parse a positive integer var with a fallback. */
export function positiveInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}
