/**
 * SOS timing and endpoint configuration (PRD §7.2.5).
 *
 * ## The relay endpoint is configuration, not code
 * PRD §7.2.5 routes the primary path through a server the team owns precisely so that no
 * provider credential — a Telegram bot token, a Textbelt key, a Twilio auth token — ever
 * ships inside the app. The relay (`relay/`, ADR-007) holds every credential and the app only
 * knows a URL. That URL is therefore read from the environment at build time, the same way
 * `EXPO_PUBLIC_OPENWEATHER_API_KEY` already is, and lives in `.env.local` (gitignored) rather
 * than in this file.
 *
 * Set it like this:
 *
 * ```
 * EXPO_PUBLIC_SOS_RELAY_URL=https://phc-sos-relay.<account>.workers.dev/sos
 * # optional, only if the deployment set RELAY_APP_KEY:
 * EXPO_PUBLIC_SOS_RELAY_KEY=<the same value>
 * ```
 *
 * The value is the **`/sos` endpoint** — a URL whose path does not end in `/sos` is treated as
 * not configured, for the reason given on {@link isUsableEndpoint}. `/health` (bot username for
 * the Telegram linking flow) and `/link` (token redemption) are resolved as its siblings by
 * {@link resolveRelayRoute}, so there is one variable rather than three that can disagree.
 *
 * ## The rename
 * The variable used to be `EXPO_PUBLIC_TWILIO_SOS_URL`, from when the relay was a Twilio
 * Function (ADR-003). It is still read as a fallback so a `.env.local` written for the previous
 * build keeps working for one release; the new name wins when both are set. Nothing is logged
 * about which one was used.
 *
 * When neither is set the primary path is *skipped*, not failed: {@link resolveRelayEndpoint}
 * returns null and `deliver.ts` goes straight to the native-SMS fallback. That is the same
 * behaviour as a relay call that times out, which means an unconfigured build still delivers
 * an alert instead of doing nothing — and it is why the missing value is a degradation rather
 * than an outage.
 *
 * `EXPO_PUBLIC_` prefix, and what it means: Expo inlines these into the JS bundle, so
 * anything here is readable by anyone with the app. A Worker URL is fine — it is an endpoint,
 * not a secret, and the Worker does its own abuse control. The optional app key is documented
 * on the relay side as bar-raising, not authentication, for exactly this reason. A bot token
 * would **not** be fine, which is the whole reason for the indirection.
 *
 * `docs/features/sos-relay.md` holds the request contract and the abuse controls.
 */

/** PRD §7.2.5: "30-second cancel window". Specified, not a tuning knob. */
export const CANCEL_WINDOW_MS = 30_000;

/** How often the countdown re-renders. 250 ms keeps the displayed second honest without
 *  the cost of an animation frame loop. */
export const COUNTDOWN_TICK_MS = 250;

/**
 * How long to wait on the relay before falling back.
 *
 * 10 seconds. The trade is stark in both directions: too short abandons a request that would
 * have succeeded on a congested network — the exact network PRD §8 says this must work on —
 * while too long strands someone who needs help behind a request that is never going to
 * complete. Ten seconds is roughly two TCP retransmission windows on a bad mobile link, and
 * the fallback that follows costs nothing but a composer the user still has to send.
 *
 * The relay's own budget is sized inside this one (3.5 s per adapter, 8 s per dispatch — see
 * `relay/src/dispatch.ts`), so a slow provider is reported by the relay rather than abandoned
 * by the phone. Change this and those numbers have to move with it.
 */
export const RELAY_TIMEOUT_MS = 10_000;

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

/** The header the relay reads its optional shared app key from (`relay/src/index.ts`). */
export const RELAY_APP_KEY_HEADER = 'X-PHC-Key';

/**
 * Rejects `http:`, anything malformed, and any path that is not the relay's `/sos` route.
 *
 * The scheme rule keeps an emergency payload out of cleartext. The path rule exists because a
 * bare origin (`https://worker.example`) is the most natural mistake to make and the worst one to
 * make silently: `/health` and `/link` would resolve fine as its siblings, so the Telegram link
 * flow would *work*, Settings would say "configured", and every SOS would POST to `/` — a 404 and
 * the composer, for a user who believed the relay was on. Requiring `…/sos` (a trailing slash is
 * tolerated; the Worker strips it) makes the half-configured state visibly unconfigured instead.
 */
function isUsableEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return url.pathname.replace(/\/+$/, '').endsWith('/sos');
  } catch {
    return false;
  }
}

/**
 * A literal placeholder left in `.env.local` is a common and dangerous half-configured state:
 * it parses as neither a URL nor an obvious mistake at a glance. `YOUR_…`, `[…]` and the
 * runbook's `<WORKER_URL>` are the shapes a copied template holds.
 */
function isPlaceholder(value: string): boolean {
  return value.startsWith('[') || value.includes('YOUR_') || value.includes('<');
}

/** One environment variable, validated: null when unset, blank, a placeholder, not https, or
 *  not the `/sos` route (see {@link isUsableEndpoint}). */
function usableEndpointFrom(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (isPlaceholder(trimmed)) return null;
  return isUsableEndpoint(trimmed) ? trimmed : null;
}

/**
 * The configured relay `/sos` endpoint, or null when it is absent or unusable.
 *
 * Read through a function rather than exported as a constant so tests can set the variable
 * and observe the effect without module-cache games. The legacy name is consulted only when
 * the new one yields nothing usable.
 */
export function resolveRelayEndpoint(): string | null {
  return (
    usableEndpointFrom(process.env.EXPO_PUBLIC_SOS_RELAY_URL) ??
    usableEndpointFrom(process.env.EXPO_PUBLIC_TWILIO_SOS_URL)
  );
}

/** Routes on the relay that the app calls besides `/sos`. */
export type RelayRoute = 'health' | 'link';

/**
 * A sibling route of the configured `/sos` endpoint.
 *
 * `https://w/sos` → `https://w/health`; `https://w/v1/sos` → `https://w/v1/link`. Relative URL
 * resolution does the path arithmetic; the only normalisation is stripping a trailing slash so
 * `…/sos/` does not become `…/sos/health`.
 */
export function resolveRelayRoute(
  route: RelayRoute,
  endpoint: string | null = resolveRelayEndpoint(),
): string | null {
  if (endpoint === null) return null;
  try {
    return new URL(route, endpoint.replace(/\/+$/, '')).toString();
  } catch {
    return null;
  }
}

/**
 * The optional shared app key, sent as {@link RELAY_APP_KEY_HEADER} on `/sos` and `/link`.
 *
 * Null when unset, so a deployment without `RELAY_APP_KEY` gets no header at all. Not a secret
 * in any real sense (it ships in the bundle) — see the module header — but never logged either.
 */
export function resolveRelayAppKey(): string | null {
  const raw = process.env.EXPO_PUBLIC_SOS_RELAY_KEY;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isPlaceholder(trimmed)) return null;
  return trimmed;
}

/** Whether the primary path is available at all. Surfaced in Settings so the user can see
 *  that SOS will fall back to the composer before they need it to. */
export function isRelayConfigured(): boolean {
  return resolveRelayEndpoint() !== null;
}
