# The SOS relay (PRD §7.2.5)

## Feature
A provider-agnostic emergency alert relay — a Cloudflare Worker in [`relay/`](../../relay/) — that
the app POSTs an SOS to and that delivers it over Telegram, Textbelt SMS or Twilio SMS, whichever
is configured, and reports per-channel results.

## Objective
PS §6 / PRD §7.2.5: automatic SOS to emergency contacts, with location, working over any data
connection, without the app holding any provider credential. The relay is the indirection that
keeps tokens and keys off the phone.

## Problem
The first relay design (ADR-003) was Twilio-only. Twilio now requires KYC and a paid top-up for
India-based accounts, so it was never deployed and every SOS today takes the native SMS composer —
which needs one tap a collapsed user cannot give. There is no free, global, KYC-free SMS service,
but there is a free, unlimited data channel (Telegram) and a free once-a-day SMS (Textbelt). The
fix is to make the relay provider-agnostic so any adapter can be switched on with an environment
variable, never with an app change.

## Status
**Relay: Built · Unit tested (vitest, mocked network) — not deployed, not device validated.**
**App: unchanged in this milestone.** The current app build still sends the legacy body to
`EXPO_PUBLIC_TWILIO_SOS_URL`; the relay accepts that body, so pointing the existing build at a
deployed Worker works without an app release. The structured body, the Telegram field on contacts,
the linking UI and the "sent via Telegram" copy are **M5 part 1b** (separate PR). The caregiver
push role (FCM) is **M5 part 2**.

No adapter is described as validated until it has delivered a real message to a second phone; the
table in [`relay/README.md`](../../relay/README.md#status--read-this-first) is the record.

## Why the indirection exists

A bot token, a Textbelt key or a Twilio Auth Token in the app would be extractable from any
installed copy: an Expo build inlines `EXPO_PUBLIC_*` values into the JS bundle, and anything in
the bundle is readable by anyone holding the APK. The Worker keeps them server-side, and the app
knows only an endpoint — which is not a secret. See [ADR-003](../decisions/ADR-003-sos-relay.md)
for the original reasoning and [ADR-007](../decisions/ADR-007-multi-channel-relay.md) for the
multi-channel decision.

## Architecture

```
phone ──POST /sos {to, message, channels}──▶ relay (Cloudflare Worker, free tier)
                                              ├─ telegram adapter  ──▶ api.telegram.org       (primary)
                                              ├─ textbelt adapter  ──▶ textbelt.com           (1 SMS/day free)
                                              ├─ twilio adapter    ──▶ api.twilio.com         (built, disabled)
                                              └─ fcm adapter       ──▶ fcm.googleapis.com     (stub, part 2)
                       ◀── { results: [{channel, ok, error?}], delivered } ──
phone: 2xx → done; non-2xx / timeout / no network → native SMS composer (unchanged, device-validated path)
```

Secrets live only in the Worker environment (`wrangler secret put`). Abuse control for the public
URL: a shared `X-PHC-Key` header (optional for free channels, **required** once a paid SMS channel
is configured — the relay answers 503 rather than run open), an in-Worker per-IP token bucket, a
Cloudflare dashboard rate-limiting rule (the one that actually holds), and a webhook that refuses
to run without its secret. Misconfiguration fails closed.

## The contract

```
POST https://<worker>/sos
Content-Type: application/json
X-PHC-Key: <RELAY_APP_KEY, only if the deployment set one>

{ "to": { "phone": "+919876543210", "telegramChatId": "123456789", "pushToken": "…" },
  "message": "PHC EMERGENCY - Asha needs help. …",
  "channels": ["telegram", "textbelt"] }
```

- `to` — one contact; at least one of `phone` (E.164), `telegramChatId`, `pushToken`. The app sends
  **one request per contact**, concurrently, so partial failure stays per-contact.
- **Legacy body still accepted:** `{ "to": "+919876543210", "message": "…" }` — exactly what
  `src/sos/twilio.ts` sends today — is treated as `to: { phone }` with the Worker's `CHANNEL_ORDER`.
- `message` — the complete alert, already composed and length-managed by the app. The relay sends
  it **verbatim**; rewriting it would put text in front of an emergency contact that no test in this
  repo covers. Max 4096 characters.
- `channels` — optional order. Unknown names are dropped; a list with nothing configured falls back
  to `CHANNEL_ORDER`.

Response: `{ "results": [ { "channel", "ok", "error"? } … ], "delivered": <any ok> }`.

Response handling, from `src/sos/twilio.ts` (unchanged by this milestone):

| Response | App behaviour |
| --- | --- |
| any `2xx` | Success — `delivered: true`. The body is not read by the current build. |
| `502` | Every channel failed (`delivered: false`) → falls back to the composer for that contact. |
| `503` | Misconfigured deployment (paid SMS channel without `RELAY_APP_KEY`) → composer. |
| `413` | Body over 16 KiB — a bug, not a runtime state. |
| `400` | Invalid body — a bug, not a runtime state; reported as a relay failure. |
| `401` / `403` | Reported as a relay auth problem (`RELAY_APP_KEY` mismatch). |
| `404` | Reported as a bad relay URL. |
| `429` | Reported as rate limited. |
| any other non-2xx | Reported as a relay failure, with the status. |
| network error, or no response within 10 s | Falls back to the native SMS composer. |

Every non-2xx and every timeout falls back per-contact to the composer, so a broken relay degrades
the alert to "needs one tap" rather than losing it.

## Channels

| Adapter | Needs | Cost | Role |
| --- | --- | --- | --- |
| `telegram` | `TELEGRAM_BOT_TOKEN`; contact linked once (below) | free, unlimited | primary when there is data |
| `textbelt` | nothing (`TEXTBELT_KEY` optional) | 1 SMS/day free; paid key removes the cap | real SMS for demo/backup |
| `twilio` | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | trial → KYC + top-up | the "serious" SMS path; **disabled** without all three |
| `fcm` | — | free | **stub** until the caregiver role exists (M5 part 2) |

Dispatch (`relay/src/dispatch.ts`): every planned channel gets one result row (sent, failed,
`not configured`, `contact has no …`, `skipped: already delivered`, `deadline exceeded`).
**Time budget:** the phone allows 10 s for the whole call, so each adapter gets 3.5 s and the
dispatch 8 s in total; an adapter that would start after the deadline is reported, not run. With
`SMS_ALWAYS=true` (default) and a phone number present, the SMS lane runs **concurrently** with the
data lane so a hung Telegram call cannot starve the SMS; exactly one SMS adapter is attempted after
a Telegram success (Textbelt preferred, then Twilio; a configured one is added when the request
named only an unconfigured SMS adapter), and a second SMS adapter runs only while nothing has been
delivered. Telegram reaching a phone does not mean the caregiver saw it; an SMS lights the lock
screen. An emergency deserves both.

## Telegram linking

A bot can only message a chat that opened it first, so a caregiver links once by tapping a link:

1. The app generates a 128-bit random `linkToken` (base64url, 22 chars, from the phone's CSPRNG)
   and shows the caregiver `https://t.me/<BOT_USERNAME>?start=<linkToken>` (`BOT_USERNAME` comes
   from `/health`; QR is a later nicety). Part 1b UI.
2. The caregiver taps it; Telegram sends `/start <linkToken>` to `POST /telegram/webhook`. The
   Worker stores `link:<linkToken> → chat_id` in KV for ten minutes and replies "Linked to PHC. You
   will receive emergency alerts here." A bare `/start` or any other text gets a help line and
   stores nothing.
3. The app polls `POST /link { linkToken }` → 404 until the tap lands, then `{ telegramChatId }`
   once (the key is deleted) and stores it in the contact.

Why a token the app makes rather than a code the caregiver types: six digits are 10^6 guesses in a
ten-minute window, which a per-IP limit does not make safe against a distributed guesser, and a
guessed code hands an attacker a caregiver's chat id. 128 bits are not guessable in any window and
only the caregiver's Telegram client ever sees the token. KV is eventually consistent (up to ~60 s
across locations), so one-time redemption is exact where the delete happens and best-effort
elsewhere inside that window — the token is worthless once the app has the chat id. The webhook
requires `TELEGRAM_WEBHOOK_SECRET` (503 without it, 401 on mismatch); it never runs open.

No phone number, no name and no health data cross this flow — the bot learns a chat id Telegram
already knows, and the app learns the same chat id.

## Implementation
- **Where:** `relay/` — its own `package.json`, TypeScript, `wrangler` v4, `@cloudflare/workers-types`,
  vitest. Deployed with one `wrangler deploy` (free tier: 100k requests/day, no card). CI runs its
  typecheck and tests in a separate job.
- **Adapters** implement one interface (`send(to, message, env) → { ok, error? }`, plus
  `configured(env)` / `applicable(to)`); none throws; every upstream call has a 3.5-second
  `AbortSignal.timeout` under an 8-second dispatch deadline — both inside the phone's 10 s.
- **Validation** is hand-rolled like the app's (no zod). E.164 only; refuse rather than guess.
- **Rate limit:** in-isolate token bucket (best-effort, documented as such) plus the dashboard rule.
- **Logging:** nothing logs a body, phone number or chat id; the only `console.*` is the error name on
  an unhandled exception.

## Files
- `relay/src/index.ts` — router (`/sos`, `/link`, `/telegram/webhook`, `/health`)
- `relay/src/contract.ts` — types + validation, legacy body
- `relay/src/dispatch.ts` — order, stop rule, `SMS_ALWAYS`
- `relay/src/adapters/{types,telegram,textbelt,twilio,fcm}.ts`
- `relay/src/link.ts` — link tokens, webhook handling
- `relay/src/ratelimit.ts` — token bucket
- `relay/wrangler.toml`, `relay/README.md` (runbook)
- App side (unchanged, reference): `src/sos/twilio.ts`, `src/sos/deliver.ts`, `src/sos/config.ts`

## Data Flow
Phone → `POST /sos` (message + one contact's destination) → Worker → provider API → caregiver. The
SOS payload is the only outbound health data, exactly as before. Link flow: Telegram → Worker (chat
id) → KV (10 min) → app. Nothing is persisted by the Worker beyond link tokens.

## Tests
`relay/test/*.test.ts` (vitest, 138 tests): validation incl. the legacy body and the link token
shape; every adapter's happy path, HTTP error, non-JSON body, real timeout via
`AbortSignal.timeout`, network error and not-configured/not-applicable guard; dispatch order,
any-ok → 200, all-fail → 502, `SMS_ALWAYS` on/off, exactly-one-SMS, skipped rows, the
unconfigured-SMS-in-plan case, concurrent lanes (a hanging Telegram does not stop Textbelt, wall
time well under the deadline), per-adapter timeout capped by the remaining deadline, `deadline
exceeded` rows; app-key 401, 503 fail-closed for paid channels without a key; rate limit 429; 413
body cap; link store/redeem/expiry/one-time; webhook 503 without secret, 401 on mismatch,
`/start <token>`, help for malformed payloads, ignored updates; the router end to end with the
real adapters over a stubbed `fetch`; and an assertion that no handler path logs the message,
phone, chat id or token.
Run: `cd relay && npm test` (also `npm run typecheck`, `npm run check` for a wrangler dry-run).

## Device Validation
**None.** The Worker has not been deployed; no adapter has delivered a real message. The app-side
composer fallback remains the only device-validated SOS path. The runbook's smoke test is the
validation event; record it in `docs/PROJECT_STATUS.md` when it happens.

## Known Limitations
- Textbelt free tier: one SMS per day **per Worker egress IP**, i.e. effectively one per day for the
  whole deployment. Fine for a demo, not for a pilot — use a paid key or Twilio.
- In-Worker rate limiting is per isolate and best-effort; the dashboard rule is the real one — and
  behind carrier CGNAT (shared IPv4, common in India) any per-IP rule counts strangers together,
  so the fail-closed key rules matter more than the IP rule.
- Textbelt's free tier is per source IP, and the Worker's egress IP is shared with other Cloudflare
  tenants: "one free SMS per day" may be zero in practice. Validation will tell.
- `disable_web_page_preview` is sent as the design specified; Telegram now prefers
  `link_preview_options` but still honours the old field.
- No destination allowlist yet (listed in abuse control below as a pilot-cohort measure).
- FCM is a stub; `msg91` (India DLT) is not implemented (interface note only in the design).
- The Worker's own tests do not exercise workerd; a plain Node vitest run with a stubbed `fetch` is
  enough for this code, and `wrangler deploy --dry-run` validates the bundle and config.

## Security
- Secrets only in Worker env; `wrangler.toml` holds none; `.dev.vars` is gitignored.
- `RELAY_APP_KEY` raises the bar for drive-by use of a public URL but ships in the app bundle — it is
  documented as bar-raising, not authentication.
- Fail closed: the webhook answers 503 without `TELEGRAM_WEBHOOK_SECRET` and 401 on a mismatch
  (constant-time compare); `/sos` and `/link` answer 503 when a paid SMS channel is configured
  without `RELAY_APP_KEY`. `/health` shows `webhookSecured`, `appKeyRequired`, `appKeySet`.
- Link tokens are app-generated 128-bit values, not guessable codes; bodies are capped at 16 KiB.
- Abuse control, in the order worth doing: `RELAY_APP_KEY` (mandatory before any paid channel);
  dashboard rate-limiting rule (CGNAT caveat); Twilio spend cap if Twilio is enabled; destination
  allowlist for a known cohort (future).

## Privacy
The message and one contact's destination leave the phone per SOS — no other health data. The Worker
does not log them and does not store them; KV holds only `linkToken → chat_id` for ten minutes. See
[`docs/security/privacy-architecture.md`](../security/privacy-architecture.md).

## Future Improvements
- **M5 part 1b (app):** `EmergencyContact.telegramChatId`/`pushToken`, structured body,
  `EXPO_PUBLIC_SOS_RELAY_URL` (old name read for one release), `X-PHC-Key` header, the linking UI
  (generate a 128-bit `linkToken` with `expo-crypto`, show the `t.me` deep link, poll `/link`),
  per-channel attempt rows ("sent via Telegram"), Settings copy listing configured channels.
- **M5 part 2:** FCM adapter (HTTP v1, service-account OAuth) + caregiver role in the app.
- Destination allowlist var for pilot cohorts; KV/Durable-Object-backed limiter if the dashboard rule
  proves insufficient.

## If it is not configured

Leaving the relay URL unset is a supported state, not a broken one. The app skips the relay and goes
straight to the native SMS composer, pre-filled with the same message and addressed to every
contact. Settings says so plainly, and the SOS screen warns during the cancel window that the SMS
app will open. The difference is one tap by the user — which is also the difference the composer
path can never remove, because neither Android nor iOS permits an app to send an SMS without the
user pressing send.

---

## Proposed status-doc updates

*(For the controller to merge into the shared docs this workstream must not edit directly.)*

### `docs/PROJECT_STATUS.md`
- Replace "Twilio relay + native SMS composer fallback … Relay not deployed" with: "multi-channel
  relay (Cloudflare Worker in `relay/`: Telegram / Textbelt / Twilio adapters, FCM stub) — *built and
  unit tested; not deployed; app still sends the legacy body*."
- Blockers: the Twilio KYC blocker is no longer blocking; the remaining user actions are a Cloudflare
  account (`wrangler login`), a Telegram bot token (@BotFather) and a second phone for the first
  delivery test.

### `docs/ROADMAP.md`
- Rename "M5 — Twilio relay deployed" to "M5 — multi-channel relay" with parts: **1a** Worker +
  adapters + linking (this PR), **1b** app dispatch + contact fields + linking UI, **2** FCM +
  caregiver role.

### `docs/JUDGE_QA.md` entry
**Q: How does the SOS reach someone if the user cannot tap send?**
A: Over any data connection the app posts the alert to a relay we own; the relay delivers it on
Telegram to a linked caregiver and, when a number is on file, also as an SMS through a gateway —
neither needs a tap. With no data at all the phone opens a pre-filled SMS that needs one tap,
because no consumer app on Android or iOS can send an SMS silently. The relay is built and unit
tested against a mocked network; it is not deployed yet, so today every SOS takes the one-tap path.

### `CHANGELOG.md` fragment
```
### Added
- `relay/`: provider-agnostic emergency alert relay as a Cloudflare Worker — Telegram, Textbelt and
  Twilio adapters (Twilio disabled without credentials), FCM stub, Telegram chat-id linking, per-IP
  rate limit, optional app key. Accepts the existing app's `{ to, message }` body. vitest suite,
  CI job, deploy runbook. Not deployed. See `docs/features/sos-relay.md`, ADR-007.
```

### `docs/BUILD_MATRIX.md` row(s)
| Feature | Built | Unit tested | Integration tested | Device validated | Notes |
| --- | --- | --- | --- | --- | --- |
| Emergency relay (Worker) | ✅ | ✅ (vitest, 138) | ✅ (router + real adapters over stubbed fetch) | ❌ | Not deployed; no adapter has sent a real message |
| Telegram linking | ✅ | ✅ | ✅ | ❌ | App UI is M5 part 1b |
