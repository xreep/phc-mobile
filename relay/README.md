# PHC emergency alert relay (Cloudflare Worker)

The phone POSTs one emergency alert per contact to this Worker; the Worker delivers it over
whichever channels are configured — **Telegram** (primary, free), **Textbelt** SMS (free tier: one
per day), **Twilio** SMS (built, disabled until credentials exist) — and reports per-channel results.
Every provider credential lives in the Worker's environment. The app knows one URL and nothing else.

Design: [`docs/superpowers/specs/2026-09-20-multi-channel-emergency-relay-design.md`](../docs/superpowers/specs/2026-09-20-multi-channel-emergency-relay-design.md) ·
contract: [`docs/features/sos-relay.md`](../docs/features/sos-relay.md) ·
decision: [`docs/decisions/ADR-007-multi-channel-relay.md`](../docs/decisions/ADR-007-multi-channel-relay.md).

## Status — read this first

| Adapter | Built | Unit tested (mocked `fetch`) | Validated against the real provider |
| --- | --- | --- | --- |
| `telegram` | yes | yes | **NO** — not deployed yet |
| `textbelt` | yes | yes | **NO** — not deployed yet |
| `twilio` | yes | yes | **NO** — no credentials; disabled |
| `fcm` | stub | yes (returns "not implemented") | — (M5 part 2) |

Nothing in this directory has sent a real message to a real phone. The unit tests prove the request
shapes and the failure handling against a stubbed network; the first `wrangler deploy` plus the smoke
test at the end of this page is what turns a row above into "validated". Update the table when it
happens.

## Layout

```
relay/
  wrangler.toml        name, compatibility date, [vars], KV binding — no secrets
  src/index.ts         router: POST /sos, POST /link, POST /telegram/webhook, GET /health
  src/contract.ts      request/response types + validation (legacy body accepted)
  src/dispatch.ts      channel order, stop rule, SMS_ALWAYS
  src/adapters/        telegram, textbelt, twilio, fcm (stub); one interface (types.ts)
  src/link.ts          Telegram chat-id linking (6-digit code, KV, 10-minute TTL, one-time)
  src/ratelimit.ts     best-effort per-IP token bucket (in-isolate)
  test/                vitest; every upstream call mocked; KV faked in memory
```

## Endpoints

### `POST /sos`

```json
{
  "to": { "phone": "+919876543210", "telegramChatId": "123456789", "pushToken": "…" },
  "message": "PHC EMERGENCY - …",
  "channels": ["telegram", "textbelt"]
}
```

- `to` — at least one of `phone` (E.164), `telegramChatId`, `pushToken`.
  **Legacy form still accepted:** `{ "to": "+919876543210", "message": "…" }` — what the current
  app build sends — is treated as `to: { phone }` with the Worker's `CHANNEL_ORDER`.
- `message` — sent **verbatim**. The app composed and length-managed it; the relay never rewrites
  it. Max 4096 characters (Telegram's ceiling).
- `channels` — optional order. Unknown names are dropped; if none of the named channels is
  configured on this deployment, `CHANNEL_ORDER` applies instead.

Response:

```json
{ "results": [ { "channel": "telegram", "ok": true },
               { "channel": "textbelt", "ok": false, "error": "textbelt: Out of quota (quotaRemaining: 0)" } ],
  "delivered": true }
```

| HTTP | Meaning |
| --- | --- |
| `200` | `delivered: true` — at least one channel succeeded |
| `502` | `delivered: false` — every channel failed; the app falls back to the SMS composer |
| `400` | invalid body (`{ "error": "…" }`) |
| `401` | `RELAY_APP_KEY` is set and `X-PHC-Key` does not match |
| `429` | per-IP rate limit (in-isolate, best-effort — see below) |

Channel rules (`src/dispatch.ts`):

1. Channels run **in order**; a channel that is not configured or whose destination field is missing
   gets a result row with the reason and costs nothing.
2. Stop at the first success — **except** with `SMS_ALWAYS=true` (the default): after a
   data-channel success (Telegram) and when the contact has a phone number, **exactly one** SMS
   adapter is still attempted (Textbelt preferred, then Twilio). Telegram reaching a phone does not
   mean the caregiver saw it; an SMS lights the lock screen. An emergency deserves both. Set
   `SMS_ALWAYS=false` in `wrangler.toml` to stop at the first success.
3. An SMS success ends the run.

### `POST /link`

`{ "code": "123456" }` → `200 { "telegramChatId": "123456789" }`, or `404` when the code is unknown,
expired (10 minutes) or already used. One-time. Gated by the app key and rate limit like `/sos`.

### `POST /telegram/webhook`

Receives Telegram bot updates. `/start` → mints a code, stores `code → chat_id` in KV for ten minutes
and replies:

> Your PHC link code is 123456 — enter it in the PHC app under Emergency contacts. Expires in 10 minutes.

Any other text gets a one-line help reply. When `TELEGRAM_WEBHOOK_SECRET` is set, the
`X-Telegram-Bot-Api-Secret-Token` header must match (401 otherwise). Always answers `200` once
authenticated so Telegram does not retry and mint a second code.

### `GET /health`

`{ ok, service, channels: { telegram, textbelt, twilio, fcm }, channelOrder, smsAlways, linking }` —
which adapters are configured. Never includes a secret.

## Configuration

Non-secret vars live in `wrangler.toml` `[vars]`:

| Var | Default | Meaning |
| --- | --- | --- |
| `CHANNEL_ORDER` | `telegram,textbelt` | Order when the request names no channels (the legacy body). Remove `textbelt` here to switch off the free-tier SMS. |
| `SMS_ALWAYS` | `true` | Attempt one SMS after a Telegram success when a phone number exists. |
| `RATE_LIMIT_PER_MINUTE` | `10` | In-isolate token bucket per IP for `/sos` and `/link`. |

Secrets (`wrangler secret put NAME`, never in the repo):

| Secret | Enables |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | `telegram` adapter + `/telegram/webhook` |
| `TELEGRAM_WEBHOOK_SECRET` | webhook header check (recommended) |
| `TEXTBELT_KEY` | paid Textbelt key; unset = `textbelt` free tier (1 SMS/day per egress IP) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | `twilio` adapter — all three or it stays `not configured` |
| `RELAY_APP_KEY` | `X-PHC-Key` check on `/sos` and `/link`. **Not a secret in the cryptographic sense**: it ships inside the app bundle. It raises the bar for drive-by abuse of a public URL; it does not authenticate the app. |

## Deploy runbook

Prerequisites: a Cloudflare account (free, no card) and a Telegram bot token from **@BotFather**
(`/newbot`, copy the token). Node 22.

```sh
cd relay
npm ci
npm run typecheck && npm test          # must be green before touching prod

npm i -g wrangler                      # or use the pinned local one via npx
wrangler login                         # opens the browser once

# 1. KV namespace for link codes — paste the printed id into wrangler.toml [[kv_namespaces]] id
npx wrangler kv namespace create LINKS

# 2. Secrets — each prompts for the value; nothing is written to disk in the repo
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET      # any long random string, e.g. `openssl rand -hex 32`
npx wrangler secret put RELAY_APP_KEY                # optional; the same value goes in the app's env
# optional: TEXTBELT_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM

# 3. Deploy — prints the workers.dev URL, e.g. https://phc-sos-relay.<account>.workers.dev
npx wrangler deploy
```

### Point the Telegram bot at the webhook

Replace the three placeholders; the secret must equal `TELEGRAM_WEBHOOK_SECRET` above.

```sh
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<WORKER_URL>/telegram/webhook" \
  -d "secret_token=<WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message"]'
# → {"ok":true,"result":true,"description":"Webhook was set"}
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Run these from a shell, not from the repo — the bot token must never land in a file here.

### Rate limiting that actually holds

`src/ratelimit.ts` is per-isolate memory: it stops a naive loop, not a distributed attacker. Add a
**Rate limiting rule** in the Cloudflare dashboard (free plan includes one):

*Security → WAF → Rate limiting rules → Create rule*
- If incoming requests match: `Hostname equals <WORKER_URL host>` **and** `URI Path is in {"/sos", "/link"}`
- With the same characteristics: `IP`
- When rate exceeds: `10` requests per `10 seconds` (the free-plan period)
- Then: `Block` for `10 seconds`

An emergency is one request per contact, once; a real user never sees this rule.
Also worth doing: a Twilio spend cap if Twilio is ever enabled, and — for a pilot cohort — a
destination allowlist (not implemented; see `docs/features/sos-relay.md`).

### Smoke test

```sh
RELAY=https://<WORKER_URL>

curl -sS "$RELAY/health"
# → {"ok":true,"service":"phc-sos-relay","channels":{"telegram":true,"textbelt":true,"twilio":false,"fcm":false},...}

# Legacy body (what the current app sends). With no Telegram chat id this goes out over Textbelt
# — the free tier allows ONE per day, so use a number you can check.
curl -sS -i "$RELAY/sos" -H 'Content-Type: application/json' \
  -H 'X-PHC-Key: <RELAY_APP_KEY if set>' \
  -d '{"to":"+91XXXXXXXXXX","message":"PHC relay smoke test - please ignore"}'

# Telegram: open the bot on the second phone, send /start, read the code, then:
curl -sS "$RELAY/link" -H 'Content-Type: application/json' -H 'X-PHC-Key: …' -d '{"code":"123456"}'
# → {"telegramChatId":"…"}; then
curl -sS -i "$RELAY/sos" -H 'Content-Type: application/json' -H 'X-PHC-Key: …' \
  -d '{"to":{"telegramChatId":"<id>"},"message":"PHC relay smoke test - please ignore","channels":["telegram"]}'
```

A `200` with `"delivered":true` **and** the message visible on the second phone is the validation
event — record it in `docs/PROJECT_STATUS.md` and flip the row in the status table above.

Then point the app at it: `EXPO_PUBLIC_SOS_RELAY_URL=https://<WORKER_URL>/sos` in `.env.local`
(the current build reads `EXPO_PUBLIC_TWILIO_SOS_URL`; the rename lands with M5 part 1b).

### Local development

```sh
cp .dev.vars.example .dev.vars   # gitignored; fill in what you have
npm run dev                      # wrangler dev on http://localhost:8787 with a local KV
npm run check                    # wrangler deploy --dry-run: bundles + validates wrangler.toml, no account needed
```

## Privacy and logging

The message and the destination are the only health-adjacent data that reach this Worker, exactly as
in the previous Twilio-only design. The code never logs a request body, a phone number or a chat id;
the only `console.*` call is the error *name* on an unhandled exception. Workers Logs / observability
is deliberately not enabled in `wrangler.toml`; if you enable it for debugging, remember that
Cloudflare will then retain request metadata (URL, status, timing — not bodies) for the retention
period.

Health language in bot replies: these are **emergency alerts** relayed on the user's behalf, never a
diagnosis, and the copy says so.
