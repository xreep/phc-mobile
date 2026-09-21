# Multi-channel emergency relay — design (M5, for approval)

**Date:** 2026-09-20 · **Status:** Approved 2026-09-20; implemented PRs #18/#20/#22
**PS:** §6 emergency assistance (SOS to caregivers, location-enabled) · **Replaces:** the Twilio-only relay plan in `docs/features/sos-relay.md` (blocked on Twilio KYC + paid top-up)

## Problem

The app's automatic SOS path POSTs `{ to, message }` to one relay URL the team owns; the relay was specified as a Twilio Function. Twilio now requires KYC and a paid top-up for India-based accounts. There is no free, global, KYC-free SMS service. The device-validated fallback (pre-filled SMS composer) needs one tap, which a collapsed user cannot give.

## Decision proposed

Keep the app's contract almost unchanged and make **the relay provider-agnostic with several adapters behind one URL**, so "all of them sit in the codebase" and any can be switched on later with an environment variable — never a code change on the phone.

| Adapter | Cost | Account/ID needed | Role today | Validation status at ship |
| --- | --- | --- | --- | --- |
| `telegram` | free, unlimited | Telegram bot token (BotFather, 2 min) | **Primary automatic path** when there is data | device-validated (user + second phone) |
| `textbelt` | 1 SMS/day free; ~$3/50 paid | none | real SMS once per day for demo/backup | device-validated once (one free send) |
| `fcm` | free | Firebase project (Google account) | push to a caregiver running phc-mobile — needs the caregiver role (part 2) | built, validated once the caregiver role exists |
| `twilio` | trial credit → KYC + top-up | Twilio account | the "serious" SMS path; **code stays, disabled** until credentials exist | BUILT — NOT VALIDATED (labelled) |
| `msg91` (India DLT) | trial → DLT registration | KYC | placeholder for an Indian pilot | NOT IMPLEMENTED — interface stub + doc only |

WhatsApp Cloud API: excluded (Meta Business verification) per the user's decision.

## Architecture

```
phone ──POST {contact, message, channels}──▶ relay (Cloudflare Worker, free tier)
                                              ├─ telegram adapter  ──▶ api.telegram.org
                                              ├─ textbelt adapter  ──▶ textbelt.com
                                              ├─ fcm adapter       ──▶ fcm.googleapis.com
                                              └─ twilio adapter    ──▶ api.twilio.com (disabled)
                       ◀── per-channel results ──
phone: any channel ok → done; all failed / no network → SMS composer (unchanged, device-validated)
```

- **Where it lives:** `relay/` directory in this repo (TypeScript, `wrangler`), its own `package.json`, unit tests with a mocked `fetch`, deployed with `wrangler deploy` (free tier: 100k req/day, no card). CI runs its tests.
- **Secrets:** only in Worker environment variables (`TELEGRAM_BOT_TOKEN`, `TEXTBELT_KEY`, `FCM_SERVER_KEY`, `TWILIO_*`). The APK keeps knowing only `EXPO_PUBLIC_SOS_RELAY_URL` (renamed from `EXPO_PUBLIC_TWILIO_SOS_URL`, with the old name still read for one release). Nothing else changes in the privacy posture: the SOS payload is the only outbound health data, exactly as today.
- **Abuse control** (the URL is public by design): per-IP rate limit in the Worker (KV/Durable Object free tier), optional allowlist of destination ids for a pilot cohort, and a shared `RELAY_APP_KEY` header that raises the bar without pretending to be a secret (it ships in the bundle; documented as such — same reasoning as `docs/features/sos-relay.md`).

## App-side changes (small)

1. **Contact schema** (`EmergencyContact`): keep `phone`; add optional `telegramChatId?: string` and `pushToken?: string`. Validate-on-read as with everything else; old blobs load unchanged.
2. **Settings UI:** per contact, optional "Telegram" field with a one-time linking flow: the contact opens the bot and sends `/start`; the relay's `/link` endpoint returns a 6-digit code the contact reads back; the app stores the resulting chat id. (No phone numbers or health data leave the device during linking.)
3. **Dispatch** (`src/sos/deliver.ts`): request body becomes `{ to: { phone, telegramChatId?, pushToken? }, message, channels: [...] }`; response `{ results: [{ channel, ok, error? }] }`. Success rule per contact: **any channel ok**. Failure or timeout → SMS composer, unchanged. `SosDeliveryAttempt.channel` gains the new channel names so the SOS screen can say "sent via Telegram".
4. **Settings copy** replaces "Automatic relay not configured" with the configured channel list.

## Part 2 — caregiver role in phc-mobile (FCM)

- A "Caregiver" section in Settings: register this phone for push (`expo-notifications` push token → shows as text/QR), and a list of people you watch (name only; their app stores *your* token in their contact entry).
- Incoming SOS push opens a **Caregiver alert screen**: who, reason, vitals, map button (`geo:` link), call button.
- Requires a Firebase project (`google-services.json` in the build → new EAS build). Ships after part 1; separate PR and gate.

## Health/safety framing

Automatic delivery over any data connection (Telegram / push / gateway SMS); with no data, a pre-filled SMS that needs one tap — because no consumer app on Android or iOS can send an SMS silently. The docs and JUDGE_QA say exactly that. No adapter is described as validated until it has delivered a real message to a second phone.

## What you need to do (only after approving)

1. Telegram: message **@BotFather** → `/newbot` → copy the bot token (you paste it into the Worker's secrets with one `wrangler secret put` command I'll give you — never into the repo).
2. Cloudflare: sign up (free, no card) and run `wrangler login` once.
3. Second phone (or a friend's) with Telegram for the first delivery test.

## Alternatives rejected

- Twilio-only (blocked: KYC + ₹; keeps its adapter, disabled).
- Sending from the phone directly to Telegram/Textbelt (bot token/key would live in the APK — the exact leak the relay exists to prevent).
- Native `SEND_SMS` permission for silent SMS (Play policy rejects it for non-messaging apps; iOS impossible).
- WhatsApp Cloud API (Meta Business verification; excluded by decision).

## Estimated effort

Part 1 (relay + 4 adapters + app dispatch + settings + docs + tests): ~1 day. Part 2 (caregiver role): ~1 day + a new EAS build.
