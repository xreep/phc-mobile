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
**Relay: Built · Unit tested (vitest, mocked network) · Deployed at
`phc-sos-relay.xreep.workers.dev` · Telegram lane validated by hand (2026-09-21: `/start
<linkToken>` → `/link` → `/sos` delivered to a real Telegram account); Textbelt answered "free SMS
disabled for this country" and the relay returned 502 as designed.**
**App (M5 part 1b): Built · Unit/Integration tested (Jest) · Device validated: NO.** The app now
sends the structured body, carries a per-contact `telegramChatId`, links a caregiver's Telegram from
Settings, and reports per contact and per channel. The legacy body is still accepted by the relay,
so an older build pointed at the Worker keeps working. The caregiver push role (FCM) is **M5 part
2**.

No adapter is described as validated until it has delivered a real message to a second phone; the
table in [`relay/README.md`](../../relay/README.md#status--read-this-first) is the record. No
*app build* has yet sent an alert through the deployed relay — that is the next validation event.

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
phone: 2xx + delivered:true → done; anything else (502, 5xx, 4xx, timeout, no network, 2xx without
       delivered:true) → native SMS composer for that contact (unchanged, device-validated path)
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
- **Legacy body still accepted:** `{ "to": "+919876543210", "message": "…" }` — what app builds
  before M5 part 1b sent — is treated as `to: { phone }` with the Worker's `CHANNEL_ORDER`.
- `message` — the complete alert, already composed and length-managed by the app. The relay sends
  it **verbatim**; rewriting it would put text in front of an emergency contact that no test in this
  repo covers. Max 4096 characters.
- `channels` — optional order. Unknown names are dropped; a list with nothing configured falls back
  to `CHANNEL_ORDER`.

Response: `{ "results": [ { "channel", "ok", "error"? } … ], "delivered": <any ok> }`.

## The contract, as the app sends it (M5 part 1b)

`src/sos/relay.ts` (`sendViaRelay(contact, message, options)`; the old `twilio.ts` is gone and every
import was updated — nothing outside `src/sos/` imported it directly). One request per contact,
concurrently, with the 10 s timeout (`RELAY_TIMEOUT_MS`, formerly `TWILIO_TIMEOUT_MS`) that the
relay's own 8 s deadline is sized inside:

```
POST <EXPO_PUBLIC_SOS_RELAY_URL>            # the /sos endpoint
Content-Type: application/json
X-PHC-Key: <EXPO_PUBLIC_SOS_RELAY_KEY>      # only when that variable is set

{ "to": { "phone": "+919876543210", "telegramChatId": "123456789" },   # chat id only when linked
  "message": "<composed by src/sos/message.ts, sent verbatim>",
  "channels": ["telegram", "textbelt", "twilio"] }
```

**Channel derivation** (`relayChannelsFor`): `['telegram']` when the contact has a `telegramChatId`,
then `['textbelt', 'twilio']` whenever there is a phone number. Both SMS adapters are always named —
the relay skips the unconfigured one — so a deployment can switch Twilio on with an environment
variable and no app release. `fcm` is never named until the caregiver role exists (part 2), and any
result row for a channel the app does not know is dropped rather than shown.

**Response handling** (pinned in `src/sos/__tests__/relay.test.ts`):

| Response | App behaviour |
| --- | --- |
| `2xx` **and** body `delivered: true` | Success. `results[].ok` names the channels that carried it; the overlay says "Sent to Meera via Telegram" / "via Telegram and SMS" / "via SMS". A failed row beside a successful one is kept for the audit trail but does **not** open the composer — one channel is enough to put the alert in front of a person. |
| `2xx` without `delivered: true`, or no readable body | Treated as a failure ("The SOS relay did not confirm delivery.") → composer for that contact. The previous client accepted a bare 204; this one cannot, because `delivered` is the only evidence a message reached a provider. |
| `502` | Every channel failed → composer for that contact, with the relay's per-channel reasons in the failed-phase list. |
| `503` | "not fully configured" (paid SMS channel without `RELAY_APP_KEY`) → composer. |
| `401` / `403` | "check the app key" → composer. |
| `404` | "relay URL was not found" → composer. |
| `429` | "rate limited" → composer. |
| any other non-2xx | "failed (status)" / "returned an error (status)" → composer. |
| network error, or no response within 10 s | "could not reach" / "timed out" → composer. |

Every non-2xx and every timeout falls back per-contact to the composer, exactly as the
device-validated build did, so a broken relay degrades the alert to "needs one tap" rather than
losing it. When no URL is configured the relay is *skipped*, not failed, and the composer opens at
once. `skipRelay` (formerly `skipTwilio`) is the caller's "I already know there is no data" branch.

**Result shape** (`SosDispatchResult`): `attempts` is one row per contact per channel — the relay's
own rows when it answered, or one row per planned channel carrying the same reason when it did not
(timeout, network, 401), plus a `native_sms` row per contact the composer covered;
`relayDelivered` is `[{ contactId, channels }]` for contacts the relay confirmed (replacing the
old `twilioSent: string[]`); `nativeSmsPending` and `failed` are unchanged. `SosChannel` is now
`'telegram' | 'textbelt' | 'twilio' | 'native_sms'`.

**Environment variable rename:** `EXPO_PUBLIC_SOS_RELAY_URL` (the `/sos` endpoint;
`/health` and `/link` are resolved as its siblings) replaces `EXPO_PUBLIC_TWILIO_SOS_URL`. The old
name is still read when the new one is unset or unusable, for one release, and nothing logs which
one was used. `EXPO_PUBLIC_SOS_RELAY_KEY` is optional and becomes the `X-PHC-Key` header on `/sos`
and `/link` when set. `.env.local` is gitignored; the README's example line still names the old
variable (controller-owned, see the tail of this doc).

**Settings copy:** "Automatic relay: configured (Telegram + SMS gateway)" / "Automatic relay: not
configured", with the description naming `EXPO_PUBLIC_SOS_RELAY_URL`.

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
dispatch 8 s in total; an adapter that would start after the deadline is reported, not run, and
one still in flight at the deadline is abandoned with a `deadline exceeded` row — the relay never
answers later than 8 s, even if a provider ignores its abort signal. With `SMS_ALWAYS=true`
(default) and a phone number present, the SMS lane runs **concurrently** with the data lane so a
hung Telegram call cannot starve the SMS — both lanes start together, so the SMS may land before
the Telegram message (plan order is a reporting order, not a sequence); exactly one SMS adapter is attempted after
a Telegram success (Textbelt preferred, then Twilio; a configured one is added when the request
named only an unconfigured SMS adapter), and a second SMS adapter runs only while nothing has been
delivered. Telegram reaching a phone does not mean the caregiver saw it; an SMS lights the lock
screen. An emergency deserves both.

## Telegram linking

A bot can only message a chat that opened it first, so a caregiver links once by tapping a link:

1. The app generates a 128-bit random `linkToken` (base64url, 22 chars, from the phone's CSPRNG)
   and shows the caregiver `https://t.me/<BOT_USERNAME>?start=<linkToken>` (`BOT_USERNAME` comes
   from `/health`; QR is a later nicety).
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

### The linking UX, app side (M5 part 1b)

In Settings → a contact's editor → **Telegram alerts** → **Link Telegram**:

1. `GET <relay>/health` for `botUsername` (`src/sos/telegram-link.ts` `fetchRelayBotUsername`). A
   relay that answers `botUsername: null` or `linking: false` cannot link, and the editor says so;
   with no relay URL at all the row reads "Relay not configured — Telegram linking needs
   `EXPO_PUBLIC_SOS_RELAY_URL`. SMS still works." and shows no button.
2. The token: `expo-crypto`'s `getRandomValues(new Uint8Array(16))` → unpadded base64url, 22
   characters, the relay's `LINK_TOKEN` regex. `getRandomValues` is the entry point the SDK 57 docs
   describe as cryptographically secure; `getRandomBytes` is documented as falling back to
   `Math.random` in development, which is why it is not used. Under Jest, `expo-crypto` is mocked
   globally with a deterministic byte ramp so the encoding is pinned exactly.
3. The editor shows the `t.me` link, the instruction "Send this link to the contact. They tap it in
   Telegram and press Start. If Telegram does not show the code, they can send `/start <code>` to
   @<bot>.", and a **Share link** button (React Native `Share.share`, the platform sheet). There is
   no Copy button: `expo-clipboard` is not installed and the share sheet reaches every messaging app
   a caregiver might already be in; the link is also rendered as selectable text.
4. `POST <relay>/link { linkToken }` **immediately, then every 10 s, for up to 10 min**
   (`src/hooks/use-telegram-link.ts`). 10 s because the relay's per-IP token bucket is 10 requests a
   minute *shared with `/sos`*: six polls a minute leaves four for an SOS that fires while a link is
   pending, where every 5 s would leave none. 10 min because that is the relay's KV TTL — polling
   past it can only ever see 404. `404` → keep waiting; `429` / `5xx` / network → keep waiting (the
   token is still good); `401` / `400` → stop with the reason; `{ telegramChatId }` → "Linked ✓".
5. The chat id lands in the editor's draft and is stored on **Save contact** (validate-on-read in
   `src/settings/store.ts`: digits with an optional leading `-`, up to 20; a malformed value drops
   the field and keeps the contact). Cancel discards it like any other unsaved edit, and the copy
   says "Save the contact to keep it". **Unlink Telegram** clears the field. The contact list shows a
   "Telegram" badge on linked contacts.
6. Polling stops when the chat id arrives, on **Unlink**, on expiry ("Link expired — try again",
   with a fresh token on retry), and when the editor closes — every step checks it is still the
   current session and the component is still mounted before touching state.

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
  an unhandled exception. The app side has no `console.*` at all in `src/sos/relay.ts`,
  `src/sos/telegram-link.ts` or the linking hook.

## Files
- `relay/src/index.ts` — router (`/sos`, `/link`, `/telegram/webhook`, `/health`)
- `relay/src/contract.ts` — types + validation, legacy body
- `relay/src/dispatch.ts` — order, stop rule, `SMS_ALWAYS`
- `relay/src/adapters/{types,telegram,textbelt,twilio,fcm}.ts`
- `relay/src/link.ts` — link tokens, webhook handling
- `relay/src/ratelimit.ts` — token bucket
- `relay/wrangler.toml`, `relay/README.md` (runbook)
- App side: `src/sos/config.ts` (env var, `RELAY_TIMEOUT_MS`, sibling routes, app key),
  `src/sos/relay.ts` (the client), `src/sos/deliver.ts` (per-contact escalation),
  `src/sos/outcome.ts` (per-contact overlay lines), `src/sos/telegram-link.ts` (token, deep link,
  `/health`, `/link`), `src/hooks/use-telegram-link.ts` (cadence and stopping),
  `src/components/contact-editor.tsx` (the linking UI), `src/app/settings.tsx` (badge, relay copy),
  `src/components/sos-alert.tsx` (per-contact outcome lines), `src/settings/store.ts`
  (`telegramChatId` validate-on-read), `src/sos/types.ts`

## Data Flow
Phone → `POST /sos` (message + one contact's destination) → Worker → provider API → caregiver. The
SOS payload is the only outbound health data, exactly as before. Link flow: Telegram → Worker (chat
id) → KV (10 min) → app. Nothing is persisted by the Worker beyond link tokens.

## Tests
**App (Jest):** `src/sos/__tests__/relay.test.ts` (body by deep equality with and without a chat
id; channel derivation; `X-PHC-Key` present only when configured; 200 + `delivered` → ok with the
successful channels; 200 + `delivered: false` and 2xx without a body → failure; 502 with per-channel
reasons; 400/401/403/404/429/500/503 mapped; network, synchronous throw, timeout, caller abort;
unconfigured → no fetch), `deliver.test.ts` (Telegram ok + SMS failed = reached, no composer;
per-contact fallback; one row per channel with the relay's reason when it answered and the same
reason across planned channels when it did not; concurrency; `skipRelay`; composer outcomes),
`outcome.test.ts` (the overlay wording), `telegram-link.test.ts` (16 bytes from `getRandomValues`,
the exact base64url of the mocked bytes and of the `+`/`/`/`=` edge bytes, the relay's regex, deep
link, instructions, chat-id validation, `/health` and `/link` mapping including 404 = pending and
429/5xx/network = retry), `src/hooks/__tests__/use-telegram-link.test.ts` (fake timers: health
fetch, immediate first poll, exactly 10 s cadence, 404 continues, success stores once and stops,
transient retry, terminal failure, expiry after 10 min with 60 polls, fresh token on restart,
unmount stops polling and never sets state, reset), `src/settings/__tests__/store.test.ts` (chat id
kept trimmed, malformed drops the field and keeps the contact, absent key not `undefined`, upsert
and unlink), `src/__tests__/settings-screen.test.tsx` (unconfigured copy; the full link flow
through the real screen over a mocked global `fetch` — bot name, link on screen, share sheet, chat
id, save, badge; badge on a stored link; unlink; cancel discards), and the existing
`sos-flow.test.tsx` / `simulate-fall.test.tsx` updated to the relay's real response shape and
asserting "Sent to Meera via Telegram" / "Sent to Ravi via SMS" / "Opened SMS app for …". None of
these calls the live relay. Suite after this workstream: 63 suites / 1454 tests.

**Relay:** `relay/test/*.test.ts` (vitest, 142 tests): validation incl. the legacy body and the link token
shape; every adapter's happy path, HTTP error, non-JSON body, real timeout via
`AbortSignal.timeout`, network error and not-configured/not-applicable guard; dispatch order,
any-ok → 200, all-fail → 502, `SMS_ALWAYS` on/off, exactly-one-SMS, skipped rows, the
unconfigured-SMS-in-plan case, concurrent lanes (a hanging Telegram does not stop Textbelt, wall
time well under the deadline), per-adapter timeout capped by the remaining deadline, `deadline
exceeded` rows for adapters not yet started and for adapters that ignore their abort signal
(dispatch returns at the deadline; a hung data lane still yields `delivered: true` from the SMS
lane); app-key 401, 503 fail-closed for paid channels without a key; rate limit 429; 413
body cap; link store/redeem/expiry/one-time; webhook 503 without secret, 401 on mismatch,
`/start <token>`, help for malformed payloads, ignored updates; the router end to end with the
real adapters over a stubbed `fetch`; and an assertion that no handler path logs the message,
phone, chat id or token.
Run: `cd relay && npm test` (also `npm run typecheck`, `npm run check` for a wrangler dry-run).

## Device Validation
**Relay:** deployed 2026-09-21; the Telegram lane delivered a real message to a real Telegram
account through `/start <linkToken>` → `/link` → `/sos` (by hand, with `curl` — recorded in
[`relay/README.md`](../../relay/README.md#status--read-this-first)). Textbelt is blocked for India
on the free tier; the relay returned 502 as designed.

**App side (this workstream): Device validated: NO.** The structured dispatch, the per-channel
overlay and the linking UI are unit/integration tested under Jest against a mocked `fetch`. No
app build has yet sent an alert through the deployed relay or completed a link from the editor on
a phone. The composer fallback path is unchanged in code and remains the device-validated SOS path.
The next validation event is: a development build with `EXPO_PUBLIC_SOS_RELAY_URL` set, one contact
linked from Settings on the phone, one SOS reaching a second phone on Telegram.

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
- The app's link poll is a foreground activity: React Native suspends JS timers in the background,
  so a user who leaves the editor to send the link in another app resumes polling on return (the
  10-minute window is wall time, so an expired token is reported as such rather than polled).
- A linked chat id is a draft until **Save contact**; a user who links and then cancels has consumed
  a token for nothing and must link again. The copy says so.
- `X-PHC-Key` ships in the bundle like any `EXPO_PUBLIC_*` value; the deployed relay currently has
  no app key set (`/health` reports `appKeySet: false`), which is fine while only free channels are
  on.
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
- **M5 part 2:** FCM adapter (HTTP v1, service-account OAuth) + caregiver role in the app
  (`EmergencyContact.pushToken`, deliberately not added in part 1b).
- App side: a QR code beside the `t.me` link; `expo-clipboard` for a Copy button if the share sheet
  proves awkward on a device; drop the legacy `EXPO_PUBLIC_TWILIO_SOS_URL` read after one release.
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
- SOS row: "multi-channel relay deployed at `phc-sos-relay.xreep.workers.dev` — Telegram lane
  validated by hand 2026-09-21; **app now sends the structured contract, links Telegram per contact
  and reports per channel (M5 part 1b, Jest-tested, not device validated)**; composer fallback
  unchanged and still the device-validated path."
- Next validation event: a dev build with `EXPO_PUBLIC_SOS_RELAY_URL` set, one contact linked from
  Settings on the phone, one SOS reaching a second phone on Telegram.

### `docs/ROADMAP.md`
- M5: **1a** relay (done, deployed) · **1b** app dispatch + contact field + linking UI (done, not
  device validated) · **2** FCM + caregiver role (next).

### `README.md`
- Replace the `.env.local` example line `EXPO_PUBLIC_TWILIO_SOS_URL=https://your-relay/sos` with
  `EXPO_PUBLIC_SOS_RELAY_URL=https://<worker>/sos` (and mention the optional
  `EXPO_PUBLIC_SOS_RELAY_KEY`); note the old name is still read for one release.

### `docs/JUDGE_QA.md` entry
**Q: How does the SOS reach someone if the user cannot tap send?**
A: Over any data connection the app posts the alert to a relay we run; the relay delivers it on
Telegram to a caregiver who linked once by tapping a link from the app's Settings, and, when a
number is on file, also as an SMS through a gateway — neither needs a tap. The screen then says per
person "Sent to Meera via Telegram". With no data at all the phone opens a pre-filled SMS that needs
one tap, because no consumer app on Android or iOS can send an SMS silently. The relay's Telegram
path has delivered a real message; the app-side path is tested against a mocked network and has
not yet been exercised from a phone.

### `CHANGELOG.md` fragment
```
### Added
- SOS dispatch speaks the multi-channel relay's contract (`{ to: { phone, telegramChatId? },
  message, channels }`, success = 2xx + `delivered: true`, per-channel results); `src/sos/relay.ts`
  replaces `twilio.ts`. Emergency contacts can link a Telegram chat from Settings via an
  app-generated 128-bit deep link (`expo-crypto`), polled every 10 s for 10 min. The SOS overlay
  reports per contact ("Sent to Meera via Telegram", "Opened SMS app for Raj"). Settings shows a
  Telegram badge on linked contacts.
### Changed
- `EXPO_PUBLIC_SOS_RELAY_URL` replaces `EXPO_PUBLIC_TWILIO_SOS_URL` (old name still read for one
  release); optional `EXPO_PUBLIC_SOS_RELAY_KEY` → `X-PHC-Key`. `SosDispatchResult.twilioSent` →
  `relayDelivered`; `DispatchOptions.twilio`/`skipTwilio` → `relay`/`skipRelay`. A 2xx without
  `delivered: true` now falls back to the composer.
```

### `docs/BUILD_MATRIX.md` row(s)
| Feature | Built | Unit tested | Integration tested | Device validated | Notes |
| --- | --- | --- | --- | --- | --- |
| Emergency relay (Worker) | ✅ | ✅ (vitest, 142) | ✅ | ✅ Telegram lane (by hand, 2026-09-21) | Textbelt blocked for India; Twilio disabled |
| App → relay dispatch (structured contract) | ✅ | ✅ (Jest) | ✅ (`sos-flow`, mocked fetch) | ❌ | Fallback to composer unchanged |
| Telegram linking (app UI) | ✅ | ✅ (Jest) | ✅ (settings screen, mocked fetch) | ❌ | Poll 10 s / 10 min; Share sheet only |
