/**
 * Firebase Cloud Messaging adapter — STUB (M5 part 2).
 *
 * Push to a caregiver running phc-mobile needs the caregiver role in the app first (a registered
 * push token and an alert screen), which is part 2 of the relay milestone. Until then this adapter
 * exists so the channel name, the `pushToken` destination field and the dispatch order are all
 * final, and the app never has to change when it lands.
 *
 * What part 2 implements here (do not start early — it needs a Firebase project and a new build):
 *   endpoint  POST https://fcm.googleapis.com/v1/projects/{FCM_PROJECT_ID}/messages:send
 *   body      { "message": { "token": to.pushToken, "data": { "type": "sos", "text": message } } }
 *   auth      Bearer <OAuth 2.0 access token> minted from a service-account JSON
 *             (`FCM_SERVICE_ACCOUNT_JSON` secret): RS256 JWT signed with WebCrypto, exchanged at
 *             https://oauth2.googleapis.com/token, scope https://www.googleapis.com/auth/firebase.messaging,
 *             cached in the isolate until ~5 minutes before expiry.
 *   The legacy server-key API (`key=` header) is shut down and must not be used.
 */

import type { Destination } from '../contract';
import type { Adapter } from './types';

export const FCM_NOT_IMPLEMENTED = 'not implemented (M5 part 2)';

export const fcm: Adapter = {
  name: 'fcm',
  kind: 'data',
  notConfiguredError: FCM_NOT_IMPLEMENTED,
  notApplicableError: 'contact has no pushToken',
  configured: () => false,
  applicable: (to: Destination) => typeof to.pushToken === 'string',
  async send() {
    return { ok: false, error: FCM_NOT_IMPLEMENTED };
  },
};
