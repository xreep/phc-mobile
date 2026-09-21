# ADR-007: A provider-agnostic, multi-channel emergency relay

## Status

Accepted (design approved 2026-09-20, Gate 2 architecture / Gate 5 secrets & privacy) — relay
implemented in `relay/` (M5 part 1a). App-side changes are M5 part 1b; the caregiver push role is
M5 part 2. Supersedes the Twilio-only relay in [ADR-003](ADR-003-sos-relay.md) as the *deployment*
plan; ADR-003's reasoning about where credentials live is unchanged and still applies.

Design record: [`docs/superpowers/specs/2026-09-20-multi-channel-emergency-relay-design.md`](../superpowers/specs/2026-09-20-multi-channel-emergency-relay-design.md).

## Context

PS §6 / PRD §7.2.5 require automatic SOS to caregivers, with location, over whatever connectivity
exists. ADR-003 fixed the credential problem by putting a serverless relay between the phone and
the SMS provider, and specified a Twilio Function as that relay. Twilio now requires KYC and a
paid top-up for India-based accounts. The relay was never deployed, so the only path that has run
on a device is the native SMS composer — which needs one tap that a collapsed user cannot give.

There is no free, global, KYC-free SMS service. There is a free, unlimited, no-KYC data channel
(Telegram bots), a free once-a-day SMS gateway (Textbelt), and free push (FCM) once the caregiver
runs the app.

## Problem

How do we get an automatic, tap-free alert to a caregiver today, without a paid account, while
keeping every provider secret off the phone and without coupling the app to a provider we may
switch away from next month?

## Options

1. **Twilio-only relay, wait for KYC/top-up.** Nothing to build; nothing works until money and
   paperwork clear, and a single provider stays baked into the deployment.
2. **Send from the phone directly** to Telegram/Textbelt. No relay to run — and the bot token or
   key would sit in the APK, the exact leak ADR-003 exists to prevent.
3. **Native `SEND_SMS` permission** for silent SMS. Play policy rejects it for non-messaging apps;
   impossible on iOS.
4. **WhatsApp Cloud API.** Requires Meta Business verification; excluded by decision.
5. **A provider-agnostic relay with several adapters behind one URL** — Telegram (primary),
   Textbelt, Twilio (kept, disabled), FCM (stub) — on a free-tier Cloudflare Worker, where any
   adapter is switched on by an environment variable and never by an app change.

## Decision

Option 5. `relay/` is a Cloudflare Worker (free tier, no card) with one adapter interface
(`send(to, message, env) → { ok, error? }` plus `configured`/`applicable` guards) and four adapters.
The app's contract stays almost unchanged — the legacy `{ to, message }` body is accepted as
`to: { phone }` with the Worker's `CHANNEL_ORDER` — and grows a structured `to` object and a
`channels` list. The response is per-channel results plus `delivered = any ok`; HTTP 200 when
delivered, 502 when nothing got through, so the app's existing "non-2xx → composer" rule holds.

Specific choices inside the decision:

- **Sequential channels, stop at first success, but SMS always attempted when a phone number
  exists (`SMS_ALWAYS=true`).** Telegram reaching a phone does not mean the caregiver saw it; an
  SMS lights the lock screen. Exactly one SMS adapter runs after a data success so a free-tier day's
  quota is not doubled.
- **Telegram linking via an app-generated 128-bit deep-link token**, not a typed code. The app
  makes a random base64url token (22 chars) and shows `https://t.me/<bot>?start=<token>`; the
  caregiver's tap delivers `/start <token>` to the webhook, which stores `token → chat_id` in KV for
  ten minutes; the app polls `/link` and redeems it once. A six-digit code (the first draft) is
  10^6 guesses in a ten-minute window — a per-IP limit does not make that safe against a
  distributed guesser, and a guessed code hands an attacker a caregiver's chat id. 128 bits are
  not guessable in any window and only the caregiver's Telegram client sees the token. Caveat: KV
  is eventually consistent (up to ~60 s across edge locations), so one-time redemption is exact
  where the delete happens and best-effort elsewhere inside that window; the token is worthless
  once the app holds the chat id, so the exposure is a duplicate read, not a leak. A bot can only
  message a chat that opened it first, and this keeps phone numbers, names and health data out of
  the linking flow entirely.
- **Secrets only in Worker env** (`wrangler secret put`); `wrangler.toml` holds none; the repo
  holds none; tests use fake tokens.
- **Abuse control fails closed.** A shared `X-PHC-Key` (bar-raising, not authentication — it
  ships in the bundle) is optional for the free channels and **required** once a paid SMS channel
  is configured: `/sos` answers 503 rather than run as an open paid relay. The Telegram webhook
  answers 503 without its secret rather than accept forged updates. Plus an in-isolate per-IP token
  bucket (best-effort; CGNAT makes per-IP counting coarse in India) and a Cloudflare dashboard
  rate-limiting rule as the enforcement that actually holds.
- **Time budget inside the phone's.** The app aborts the relay call at 10 s, so each adapter gets
  3.5 s and the whole dispatch 8 s, and the SMS lane runs concurrently with the data lane — the
  relay's own SMS fallback must always have time to run before the phone gives up.
- **Never log payloads.** No `console.*` carries a body, phone number or chat id.
- **Twilio stays in the codebase, disabled** until all three credentials exist; nothing is described
  as validated until it has delivered a real message to a second phone.

## Consequences

- Automatic delivery becomes possible on a free stack: a Telegram bot token and a Cloudflare login
  are the only prerequisites. The app build in the field can be pointed at a deployed Worker without
  an app release.
- The app-side work (contact fields, structured body, linking UI, "sent via Telegram") is a separate
  PR (part 1b) and a separate gate; until it lands the relay runs in legacy mode (phone only).
- Textbelt's free tier is one SMS per day per egress IP — a demo tool, not a pilot tool. A pilot
  needs a paid key or Twilio.
- The Worker is a second toolchain in the repo (`relay/package.json`, vitest, wrangler) with its own
  CI job; the app's `tsconfig.json` and `jest.config.js` exclude `relay/` so neither toolchain sees
  the other's files.
- Operational work moves to the runbook (`relay/README.md`): KV namespace, secrets, webhook
  registration, the dashboard rule, the smoke test that constitutes validation.
- Privacy posture is unchanged from ADR-003: the SOS payload remains the only outbound health data,
  and now the Worker additionally holds `linkToken → chat_id` for ten minutes during linking.
- A deployment must set `TELEGRAM_WEBHOOK_SECRET` (and `RELAY_APP_KEY` before any paid channel) or
  the affected routes answer 503; `/health` reports both so a misconfiguration is visible before
  the first alert.

## Addendum — app side (M5 part 1b, 2026-09-21)

The phone now speaks the structured contract rather than the legacy body. `src/sos/relay.ts`
(replacing `twilio.ts`) POSTs `{ to: { phone, telegramChatId? }, message, channels }` per contact,
where `channels` is `['telegram']` when the contact has linked plus `['textbelt', 'twilio']`
whenever there is a number — both SMS adapters are always named so a deployment can switch Twilio
on with an environment variable and no app release, which is the property this ADR was written
for. Success is `2xx` **and** `delivered: true`; anything else, including the relay's 502 and a
timeout, falls back per contact to the device-validated SMS composer exactly as before.
`EmergencyContact` gains an optional `telegramChatId` (validate-on-read: a malformed value drops
the field, never the contact), the contact editor links a caregiver's Telegram through the
app-generated 128-bit deep-link token (`expo-crypto` `getRandomValues`, polled every 10 s for the
relay's 10-minute TTL — 10 s because the relay's per-IP bucket is 10/min shared with `/sos`), and
the overlay reports per contact and per channel ("Sent to Meera via Telegram", "Opened SMS app for
Raj"). `EXPO_PUBLIC_SOS_RELAY_URL` replaces `EXPO_PUBLIC_TWILIO_SOS_URL`, which is still read for one
release. The relay's Telegram lane was validated by hand on 2026-09-21; the app-side dispatch and
linking UI are unit/integration tested (Jest) and **not** device validated.

## Alternatives rejected

See Options 1–4 above. In one line each: Twilio-only is blocked on KYC and money; phone-direct puts
the secret in the APK; `SEND_SMS` is policy-rejected and iOS-impossible; WhatsApp needs business
verification.
