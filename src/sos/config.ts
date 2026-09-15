/**
 * SOS timing and endpoint configuration (PRD §7.2.5).
 *
 * ## The Twilio endpoint is configuration, not code
 * PRD §7.2.5 routes the primary path through a serverless function precisely so that no
 * Twilio account SID or auth token ever ships inside the app — the function holds the
 * credentials and the app only knows a URL. That URL is therefore read from the environment
 * at build time, the same way `EXPO_PUBLIC_OPENWEATHER_API_KEY` already is, and lives in
 * `.env.local` (gitignored) rather than in this file.
 *
 * Set it like this:
 *
 * ```
 * EXPO_PUBLIC_TWILIO_SOS_URL=https://your-service-1234.twil.io/sos
 * ```
 *
 * When it is unset the primary path is *skipped*, not failed: {@link resolveTwilioEndpoint}
 * returns null and `deliver.ts` goes straight to the native-SMS fallback. That is the same
 * behaviour as a Twilio call that times out, which means an unconfigured build still
 * delivers an alert instead of doing nothing — and it is why the missing value is a
 * degradation rather than an outage.
 *
 * `EXPO_PUBLIC_` prefix, and what it means: Expo inlines these into the JS bundle, so
 * anything here is readable by anyone with the app. A function URL is fine — it is an
 * endpoint, not a secret, and the function itself must do its own abuse control. A Twilio
 * auth token would **not** be fine, which is the whole reason for the indirection.
 *
 * `docs/sos-relay.md` holds the request contract, a working reference function, and the abuse
 * controls that endpoint needs given that its URL ships in the bundle.
 */

/** PRD §7.2.5: "30-second cancel window". Specified, not a tuning knob. */
export const CANCEL_WINDOW_MS = 30_000;

/** How often the countdown re-renders. 250 ms keeps the displayed second honest without
 *  the cost of an animation frame loop. */
export const COUNTDOWN_TICK_MS = 250;

/**
 * How long to wait on the serverless function before falling back.
 *
 * 10 seconds. The trade is stark in both directions: too short abandons a request that would
 * have succeeded on a congested network — the exact network PRD §8 says this must work on —
 * while too long strands someone who needs help behind a request that is never going to
 * complete. Ten seconds is roughly two TCP retransmission windows on a bad mobile link, and
 * the fallback that follows costs nothing but a composer the user still has to send.
 */
export const TWILIO_TIMEOUT_MS = 10_000;

/**
 * Location-fix budget before the alert goes out without coordinates.
 *
 * Deliberately shorter than the environment feed's 8 s: that path can afford to wait because
 * nothing is wrong, whereas here every second is spent while someone may be unconscious. A
 * message with no coordinates still tells a contact to call, so the fix is best-effort.
 */
export const LOCATION_TIMEOUT_MS = 6_000;

/**
 * Quiet period after a dispatch before the same trigger may fire again.
 *
 * Without it, a critical rule that stays true — `heat.stillness.critical` persists as long as
 * the user is still, by construction — would re-arm on the next 60-second evaluation tick and
 * text every contact once a minute. Five minutes is long enough to be quiet and short enough
 * that a genuinely worsening situation still re-alerts.
 */
export const REDISPATCH_COOLDOWN_MS = 5 * 60_000;

/** Rejects `http:` and anything malformed, so a typo cannot silently send an emergency
 *  payload in cleartext or to nowhere. */
function isUsableEndpoint(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The configured serverless endpoint, or null when it is absent or unusable.
 *
 * Read through a function rather than exported as a constant so tests can set the variable
 * and observe the effect without module-cache games.
 */
export function resolveTwilioEndpoint(): string | null {
  const raw = process.env.EXPO_PUBLIC_TWILIO_SOS_URL;
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // A literal placeholder left in `.env.local` is a common and dangerous half-configured
  // state: it parses as neither a URL nor an obvious mistake at a glance. Treat the shape as
  // unset so the app falls back instead of POSTing to a bracketed string.
  if (trimmed.startsWith('[') || trimmed.includes('YOUR_')) return null;

  return isUsableEndpoint(trimmed) ? trimmed : null;
}

/** Whether the primary path is available at all. Surfaced in Settings so the user can see
 *  that SOS will fall back to the composer before they need it to. */
export function isTwilioConfigured(): boolean {
  return resolveTwilioEndpoint() !== null;
}
