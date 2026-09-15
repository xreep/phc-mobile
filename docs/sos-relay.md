# The SOS relay (PRD §7.2.5)

The app's primary SOS path POSTs to a serverless function that you deploy and own. The app never
holds Twilio credentials — it knows one URL and nothing else. This document is the contract and a
working reference implementation.

## Why the indirection exists

A Twilio Account SID and Auth Token in the app would be extractable from any installed copy: an
Expo build inlines `EXPO_PUBLIC_*` values into the JS bundle, and anything in the bundle is
readable by anyone holding the APK. Those credentials can send messages, buy numbers, and spend
money. The function keeps them server-side, where the app cannot leak them, and the app knows only
an endpoint — which is not a secret.

## The contract

```
POST <your function URL>
Content-Type: application/json

{ "to": "+919876543210", "message": "PHC EMERGENCY - Asha needs help. …" }
```

- `to` — a single recipient in E.164. The app sends **one request per contact**, concurrently,
  rather than one request with a list. Partial failure is then per-contact: a relay that rejects one
  bad number does not push the whole contact list into the SMS composer and text everyone twice.
- `message` — the complete SMS body, already composed and length-managed by the app. The function
  must send it verbatim; rewriting it here would put text in front of an emergency contact that no
  test in this repo covers.

Response handling, from `src/sos/twilio.ts`:

| Response | App behaviour |
| --- | --- |
| any `2xx` | Success. The body is not read at all, so your function may return whatever shape it likes — including an empty `204`. |
| `401` / `403` | Reported as a relay auth problem. |
| `404` | Reported as a bad relay URL. |
| `429` | Reported as rate limited. |
| any other non-2xx | Reported as a relay failure, with the status. |
| network error, or no response within 10 s | Falls back to the native SMS composer. |

Every non-2xx and every timeout falls back per-contact to the composer, so a broken function
degrades the alert to "needs one tap" rather than losing it.

## Reference implementation (Twilio Functions)

Create a Service in the Twilio Console → **Functions & Assets**, add a function at path `/sos`, set
it to **Protected** or **Public** (see the abuse note below), and add an environment variable
`SOS_FROM_NUMBER` holding the Twilio number you send from. `ACCOUNT_SID` and `AUTH_TOKEN` are
injected by the runtime — do not add them yourself.

```javascript
exports.handler = async function (context, event, callback) {
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  const to = typeof event.to === 'string' ? event.to.trim() : '';
  const message = typeof event.message === 'string' ? event.message : '';

  // Validate before spending a message. E.164 only: the app normalizes at its own storage
  // boundary, so anything else arriving here is a bug or an abuse attempt, and either way the
  // right answer is to refuse rather than to guess a country code.
  if (!/^\+[1-9]\d{7,14}$/.test(to) || message.length === 0) {
    response.setStatusCode(400);
    response.setBody({ error: 'Expected { to: E.164 string, message: non-empty string }' });
    return callback(null, response);
  }

  try {
    await context.getTwilioClient().messages.create({
      to,
      from: context.SOS_FROM_NUMBER,
      body: message, // verbatim — the app composed this
    });

    response.setStatusCode(200);
    response.setBody({ ok: true });
    return callback(null, response);
  } catch (error) {
    // Return a status, never throw: the app reads the status code to decide whether to fall back
    // to the SMS composer, and an unhandled throw becomes a 500 with a stack trace in the body.
    console.error('SOS relay failed', { to, code: error.code });
    response.setStatusCode(502);
    response.setBody({ error: 'Upstream send failed' });
    return callback(null, response);
  }
};
```

Then point the app at it:

```
EXPO_PUBLIC_TWILIO_SOS_URL=https://your-service-1234.twil.io/sos
```

in `.env.local` (gitignored). Restart the bundler — Expo inlines this at build time, so a running
dev server will not pick it up.

## Abuse control is the function's job

The URL is in the app bundle and therefore public. Anyone who extracts it can POST to it. The app
cannot defend this: a shared secret sent from the app would sit in the same bundle as the URL.

Practical mitigations, in the order they are worth doing:

1. **Twilio spend controls.** A hard monthly cap in the Console bounds the worst case in money
   terms regardless of everything else. Do this one first.
2. **Rate limit per source IP** in the function, backed by a Sync map. An emergency alert is a
   handful of messages, so a low ceiling costs a real user nothing.
3. **Allowlist destination numbers** if the deployment is for a known group — a pilot cohort or a
   family. This turns the endpoint from "sends SMS to anywhere" into "sends SMS to these people",
   which removes most of the incentive to abuse it.
4. Set the function to **Protected** and have the app send a Twilio signature — only worth it if you
   are prepared to move the signing server-side, which for this architecture means another hop.

## If it is not configured

Leaving `EXPO_PUBLIC_TWILIO_SOS_URL` unset is a supported state, not a broken one. The app skips the
relay and goes straight to the native SMS composer, pre-filled with the same message and addressed to
every contact. Settings says so plainly ("Automatic relay not configured"), and the SOS screen warns
during the cancel window that the SMS app will open. The difference is one tap by the user — which is
also the difference that the composer path can never remove, because neither Android nor iOS permits
an app to send an SMS without the user pressing send.
