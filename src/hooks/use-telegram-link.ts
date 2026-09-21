/**
 * Drives the Telegram linking flow for the contact editor (ADR-007, M5 part 1b).
 *
 * ## What lives here and what does not
 * The primitives — token generation, the deep link, the `/health` and `/link` calls and what
 * their statuses mean — are pure-ish functions in `src/sos/telegram-link.ts`, each tested on
 * its own. This hook is the impure shell: the sequence (bot name → token → link → poll), the
 * cadence, and the two ways it has to stop (the chat id arrived; the editor closed).
 *
 * ## Stopping is the part that matters
 * A poll that outlives the editor keeps hitting the relay for ten minutes — at the relay's
 * per-IP budget, that is a real cost to an SOS that fires meanwhile — and then calls
 * `setState` on an unmounted component. So every step checks that it is still the current
 * session *and* that the component is still mounted before touching state, and the cleanup
 * clears whichever timer is pending. Starting again (after "expired") bumps the session so a
 * poll from the old token cannot report into the new one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchRelayBotUsername,
  generateLinkToken,
  LINK_POLL_INTERVAL_MS,
  LINK_POLL_TIMEOUT_MS,
  redeemLinkToken,
  telegramDeepLink,
  type RelayCallOptions,
} from '@/sos/telegram-link';

export type TelegramLinkState =
  | { readonly status: 'idle' }
  /** Fetching the bot name from `/health`. */
  | { readonly status: 'starting' }
  /** The link is on screen; polling `/link` until the caregiver taps it. */
  | {
      readonly status: 'waiting';
      readonly botUsername: string;
      readonly linkToken: string;
      readonly link: string;
    }
  | { readonly status: 'linked'; readonly telegramChatId: string }
  /** Ten minutes passed — the relay's TTL — with no tap. */
  | { readonly status: 'expired' }
  /** This build or this relay cannot link at all (no URL; no bot; no KV). Not retryable here. */
  | { readonly status: 'unavailable'; readonly error: string }
  /** The relay answered in a way that will not change by waiting (wrong app key, bad token). */
  | { readonly status: 'failed'; readonly error: string };

export type UseTelegramLinkOptions = RelayCallOptions & {
  /** Called once, with the chat id, when the caregiver's tap lands. */
  readonly onLinked?: (telegramChatId: string) => void;
  /** Injected in tests. */
  readonly nowImpl?: () => number;
};

export type TelegramLinkController = {
  readonly state: TelegramLinkState;
  /** Begin (or begin again, with a fresh token). */
  readonly start: () => void;
  /** Back to idle; stops any polling. */
  readonly reset: () => void;
};

export function useTelegramLink(options: UseTelegramLinkOptions = {}): TelegramLinkController {
  const [state, setState] = useState<TelegramLinkState>({ status: 'idle' });

  // The latest options, read at call time rather than captured by `start` — the editor passes
  // a fresh `onLinked` closure every render and the poll must call the current one.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const mountedRef = useRef(true);
  const sessionRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const start = useCallback(() => {
    sessionRef.current += 1;
    const session = sessionRef.current;
    const live = () => mountedRef.current && sessionRef.current === session;
    const callOptions = (): RelayCallOptions => {
      const { fetchImpl, endpoint, timeoutMs, signal } = optionsRef.current;
      const picked: { -readonly [K in keyof RelayCallOptions]: RelayCallOptions[K] } = {};
      if (fetchImpl !== undefined) picked.fetchImpl = fetchImpl;
      if (endpoint !== undefined) picked.endpoint = endpoint;
      if (timeoutMs !== undefined) picked.timeoutMs = timeoutMs;
      if (signal !== undefined) picked.signal = signal;
      return picked;
    };
    const now = () => (optionsRef.current.nowImpl ?? Date.now)();

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setState({ status: 'starting' });

    void (async () => {
      const bot = await fetchRelayBotUsername(callOptions());
      if (!live()) return;
      if (!bot.ok) {
        setState({ status: 'unavailable', error: bot.error });
        return;
      }

      const linkToken = generateLinkToken();
      setState({
        status: 'waiting',
        botUsername: bot.botUsername,
        linkToken,
        link: telegramDeepLink(bot.botUsername, linkToken),
      });

      const startedAt = now();
      // First look at once — the caregiver may tap within seconds — then every interval until
      // the relay's TTL has passed. See `sos/telegram-link.ts` for why 10 s and 10 min.
      for (;;) {
        const outcome = await redeemLinkToken(linkToken, callOptions());
        if (!live()) return;

        if (outcome.status === 'linked') {
          setState({ status: 'linked', telegramChatId: outcome.telegramChatId });
          optionsRef.current.onLinked?.(outcome.telegramChatId);
          return;
        }
        if (outcome.status === 'failed') {
          setState({ status: 'failed', error: outcome.error });
          return;
        }

        // A 429 means the shared per-IP bucket is empty; skipping a cycle lets it refill rather
        // than draining it again at the next tick (see `sos/telegram-link.ts`).
        const wait =
          outcome.status === 'retry' && outcome.rateLimited === true
            ? LINK_POLL_INTERVAL_MS * 2
            : LINK_POLL_INTERVAL_MS;
        await new Promise<void>((resolve) => {
          timerRef.current = setTimeout(resolve, wait);
        });
        timerRef.current = null;
        if (!live()) return;

        if (now() - startedAt >= LINK_POLL_TIMEOUT_MS) {
          setState({ status: 'expired' });
          return;
        }
      }
    })();
  }, []);

  const reset = useCallback(() => {
    sessionRef.current += 1;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setState({ status: 'idle' });
  }, []);

  return { state, start, reset };
}
