/**
 * The HTTP contract between the app and the relay — types plus hand-rolled validation.
 *
 * ## Backwards compatibility is a requirement, not a nicety
 * The app build in the field (`src/sos/twilio.ts`) POSTs `{ "to": "+91…", "message": "…" }` and
 * treats any non-2xx as "fall back to the SMS composer". That body must keep working unchanged:
 * `to` becomes `{ phone }`, and the channel order comes from the Worker's `CHANNEL_ORDER` var.
 *
 * ## Validation is strict on shape, lenient on unknown channel names
 * A malformed body is a 400 (refuse rather than guess a country code — same reasoning as the
 * Twilio Function this replaces). Unknown channel names are dropped rather than rejected so a newer
 * app can name an adapter this relay does not have yet without losing the ones it does.
 *
 * No zod: the app validates by hand at every boundary and this stays consistent with it.
 */

export const CHANNEL_NAMES = ['telegram', 'textbelt', 'twilio', 'fcm'] as const;
export type ChannelName = (typeof CHANNEL_NAMES)[number];

export function isChannelName(value: string): value is ChannelName {
  return (CHANNEL_NAMES as readonly string[]).includes(value);
}

/** Where a contact can be reached. At least one field is present after validation. */
export interface Destination {
  /** E.164, e.g. "+919876543210". */
  readonly phone?: string;
  /** Telegram chat id obtained through the linking flow (src/link.ts). */
  readonly telegramChatId?: string;
  /** Push token for the caregiver app (M5 part 2). Accepted now, unused by the FCM stub. */
  readonly pushToken?: string;
}

export interface SosRequest {
  readonly to: Destination;
  /** Sent verbatim — the app composed and length-managed it. Never rewritten here. */
  readonly message: string;
  /** Explicit channel order, or undefined → the Worker's `CHANNEL_ORDER`. */
  readonly channels: readonly ChannelName[] | undefined;
  /** True when the body was the legacy `{ to: "<phone>", message }` shape. */
  readonly legacy: boolean;
}

export interface ChannelResult {
  readonly channel: ChannelName;
  readonly ok: boolean;
  /** Short, safe-to-show reason. Never contains a token or key. */
  readonly error?: string;
}

export interface SosResponse {
  readonly results: readonly ChannelResult[];
  /** True when any channel succeeded. Mirrors HTTP 200 vs 502. */
  readonly delivered: boolean;
}

export interface LinkRequest {
  /** Six digits, as shown by the bot. */
  readonly code: string;
}

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

// The app normalizes at its own storage boundary, so anything else arriving here is a bug or an
// abuse attempt; either way refuse. Same pattern as the reference Twilio Function.
export const E164 = /^\+[1-9]\d{7,14}$/;
// Telegram chat ids are 64-bit integers; groups/channels are negative.
const TELEGRAM_CHAT_ID = /^-?\d{1,20}$/;
const LINK_CODE = /^\d{6}$/;
/** Telegram's per-message ceiling; SMS bodies are far shorter. */
export const MAX_MESSAGE_LENGTH = 4096;
const MAX_PUSH_TOKEN_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  pattern: RegExp | null,
  maxLength: number,
): Validation<string | undefined> {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, error: `to.${key} must be a string` };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  if (trimmed.length > maxLength) return { ok: false, error: `to.${key} is too long` };
  if (pattern !== null && !pattern.test(trimmed)) {
    return { ok: false, error: `to.${key} is not in the expected format` };
  }
  return { ok: true, value: trimmed };
}

function validateDestination(raw: unknown): Validation<Destination> {
  if (typeof raw === 'string') {
    const phone = raw.trim();
    if (!E164.test(phone)) return { ok: false, error: 'to must be an E.164 phone number' };
    return { ok: true, value: { phone } };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: 'to must be an E.164 string or an object' };
  }

  const phone = optionalString(raw, 'phone', E164, 16);
  if (!phone.ok) return phone;
  const telegramChatId = optionalString(raw, 'telegramChatId', TELEGRAM_CHAT_ID, 21);
  if (!telegramChatId.ok) return telegramChatId;
  const pushToken = optionalString(raw, 'pushToken', null, MAX_PUSH_TOKEN_LENGTH);
  if (!pushToken.ok) return pushToken;

  if (phone.value === undefined && telegramChatId.value === undefined && pushToken.value === undefined) {
    return { ok: false, error: 'to needs at least one of phone, telegramChatId, pushToken' };
  }

  const destination: { phone?: string; telegramChatId?: string; pushToken?: string } = {};
  if (phone.value !== undefined) destination.phone = phone.value;
  if (telegramChatId.value !== undefined) destination.telegramChatId = telegramChatId.value;
  if (pushToken.value !== undefined) destination.pushToken = pushToken.value;
  return { ok: true, value: destination };
}

function validateChannels(raw: unknown): Validation<readonly ChannelName[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'channels must be an array of strings' };
  const names: ChannelName[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, error: 'channels must be an array of strings' };
    const name = entry.trim().toLowerCase();
    if (isChannelName(name) && !names.includes(name)) names.push(name);
  }
  // An array that named only unknown channels is treated as "no preference" so the Worker's
  // default order applies — the alert still goes out.
  return { ok: true, value: names.length > 0 ? names : undefined };
}

/** Validate a parsed JSON body for `POST /sos`. */
export function validateSosRequest(body: unknown): Validation<SosRequest> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };

  const message = body['message'];
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { ok: false, error: 'message must be a non-empty string' };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `message must be at most ${MAX_MESSAGE_LENGTH} characters` };
  }

  const legacy = typeof body['to'] === 'string';
  const to = validateDestination(body['to']);
  if (!to.ok) return to;

  const channels = validateChannels(body['channels']);
  if (!channels.ok) return channels;

  // The legacy client never sends `channels`, so `undefined` → CHANNEL_ORDER applies. A body that
  // mixes a string `to` with a `channels` array is honoured as written; nothing is lost by it.
  return { ok: true, value: { to: to.value, message, channels: channels.value, legacy } };
}

/** Validate a parsed JSON body for `POST /link`. */
export function validateLinkRequest(body: unknown): Validation<LinkRequest> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' };
  const code = body['code'];
  const normalized = typeof code === 'string' ? code.trim() : typeof code === 'number' ? String(code) : '';
  if (!LINK_CODE.test(normalized)) return { ok: false, error: 'code must be six digits' };
  return { ok: true, value: { code: normalized } };
}

/** Parse `CHANNEL_ORDER` ("telegram, textbelt") into known names, order kept, duplicates dropped. */
export function parseChannelOrder(value: string | undefined): readonly ChannelName[] {
  const names: ChannelName[] = [];
  for (const part of (value ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (isChannelName(name) && !names.includes(name)) names.push(name);
  }
  return names;
}
