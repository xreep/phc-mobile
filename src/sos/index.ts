/**
 * Public surface of the emergency SOS module (PRD §7.2.5).
 *
 * Screens and hooks import from here rather than reaching into individual modules, matching
 * `src/risk/index.ts` and `src/environment/index.ts`. The internal split — phone
 * normalization, message composition, the pure state machine, the two delivery channels — is
 * then free to change without a hunt through the app for import paths.
 *
 * ## The boundary this module sits behind
 * The risk engine reports critical triggers and never acts on them. Everything on the acting
 * side lives here: consent, the 30-second cancel window, the location fix, composition, and
 * delivery. Nothing in `src/risk/` imports from this directory, and that direction is the
 * point — a rule change can never accidentally place an emergency call.
 */

export {
  CANCEL_WINDOW_MS,
  COUNTDOWN_TICK_MS,
  isRelayConfigured,
  LOCATION_TIMEOUT_MS,
  REDISPATCH_COOLDOWN_MS,
  RELAY_TIMEOUT_MS,
  resolveRelayEndpoint,
  resolveRelayRoute,
} from './config';

export { dispatchSos, type DispatchOptions } from './deliver';

export { resolveSosLocation, type ResolveSosLocationOptions } from './location';

export {
  countdownRemainingMs,
  countdownSeconds,
  DEFAULT_SOS_MACHINE_CONFIG,
  INITIAL_SOS_STATE,
  sosReducer,
  triggerSignature,
  type SosEvent,
  type SosMachineConfig,
  type SosMachineState,
} from './machine';

export {
  composeSosMessage,
  describeCriticalRule,
  estimateSmsSegments,
  isGsm7Safe,
} from './message';

export { sendViaNativeSms, type NativeSmsOptions, type NativeSmsResult } from './native-sms';

export { describeDispatch, type DispatchLine } from './outcome';

export { formatPhoneForDisplay, isValidPhone, normalizePhone } from './phone';

export {
  relayChannelsFor,
  sendViaRelay,
  type RelayChannelResult,
  type RelaySendOptions,
  type RelaySendResult,
} from './relay';

export {
  fetchRelayBotUsername,
  generateLinkToken,
  isTelegramChatId,
  LINK_POLL_INTERVAL_MS,
  LINK_POLL_TIMEOUT_MS,
  normalizeTelegramChatId,
  redeemLinkToken,
  telegramDeepLink,
  telegramLinkInstructions,
  type BotUsernameResult,
  type RedeemResult,
  type RelayCallOptions,
} from './telegram-link';

export type {
  EmergencyContact,
  SosChannel,
  SosContext,
  SosDeliveryAttempt,
  SosDispatchResult,
  SosLocation,
  SosLocationFailure,
  SosLocationResult,
  SosPhase,
  SosRelayDelivery,
  SosTrigger,
} from './types';
