# ADR-003: SOS via a serverless credential relay

## Status
Accepted — reflected in `src/sos/twilio.ts`, `src/sos/config.ts`, `src/sos/deliver.ts`. Documented in
detail in [`docs/features/sos-relay.md`](../features/sos-relay.md), which this ADR is based on.

## Context
PRD §7.2.5 and PS 26181 area 6b require automatic SOS to emergency contacts with location, working
even with limited connectivity. Sending SMS programmatically (rather than only via the native
composer) needs an SMS provider — this build uses Twilio.

## Problem
Where do the Twilio credentials (Account SID, Auth Token) live? Putting them in the app is the naive
approach but has a specific, concrete failure mode described below.

## Options
1. **Embed Twilio credentials directly in the app** (even behind `EXPO_PUBLIC_*` or obfuscation).
2. **A serverless relay function** that holds the credentials server-side; the app knows only the
   relay's URL and POSTs `{ to, message }` per contact.
3. **No programmatic SMS at all** — rely solely on the native SMS composer (user taps send).

## Decision
Option 2. `src/sos/twilio.ts` POSTs one request per contact to a URL read from
`EXPO_PUBLIC_TWILIO_SOS_URL`. The reference relay implementation (a Twilio Function) validates the
`to`/`message` shape, sends via the Twilio SDK using credentials injected by the Twilio runtime, and
returns a bare status code — never the message body. Every non-2xx response or a 10-second timeout
falls back, per contact, to the native SMS composer (Option 3, kept as the universal fallback).

## Reason
- **Credential extraction is not preventable in the app.** Expo inlines any `EXPO_PUBLIC_*` value into
  the JS bundle at build time; anything in an installed APK is extractable by anyone holding the file.
  A Twilio Account SID and Auth Token in the bundle could send messages, buy numbers, and spend money
  on the team's account — this is a real, not theoretical, risk for a hackathon build that will be
  shared as an APK.
- **The relay URL being public is an acceptable, bounded risk**; the credentials are not. The relay
  design accepts that the URL is extractable and pushes mitigation (spend caps, rate limiting,
  destination allowlisting) to the function, which is documented and can be tightened per deployment
  without an app update.
- **Degrading gracefully to the composer** means a broken or undeployed relay does not lose the SOS
  path — it turns "automatic" into "needs one tap," never into "nothing happens."

## Consequences
- The relay must be deployed and its URL configured for the "automatic" SMS experience; until then
  (the state today — `EXPO_PUBLIC_TWILIO_SOS_URL` is unset), every SOS goes straight to the composer,
  which is a supported, not broken, state.
- Abuse control (spend caps, rate limiting, destination allowlisting, optional signed-request
  Protected mode) is the relay's responsibility, not the app's, and has to be configured
  independently of the app release cycle.
- No test in this repository exercises a real deployed relay end-to-end; that is Level 4/5 work per
  `docs/testing/validation-levels.md`, tracked as M5 in `docs/ROADMAP.md`.

## Alternatives rejected
- **Embed credentials in the app** — rejected: guaranteed extraction from any installed copy, with a
  direct financial and abuse consequence (an extracted Twilio credential can send messages and incur
  charges on the team's account).
- **No programmatic SMS, composer only** — not rejected as a fallback (it is the fallback), but
  rejected as the *only* path: it requires the user to be conscious and able to tap "send" per
  contact during a critical event, which defeats the point of an automatic SOS for e.g. a
  loss-of-consciousness scenario.
