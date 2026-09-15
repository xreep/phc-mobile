/**
 * Types for the emergency SOS module (PRD §7.2.5).
 *
 * ## Where the boundary sits
 * The risk engine (`src/risk/`) *reports* critical triggers through
 * `RiskAssessment.criticalRules` / `.sosCandidate` and deliberately never acts on them —
 * see the header of `src/risk/index.ts`. Everything on the acting side of that line lives
 * here: the 30-second cancel window, the location fix, message composition, delivery, and
 * the consent gate.
 *
 * Like the risk engine, the pure parts of this module (`phone.ts`, `message.ts`, the state
 * reducer in `machine.ts`) take their inputs explicitly and read no clock, so the cancel
 * window and the escalation sequence are unit-testable without a device or fake timers.
 */

import type { RiskLevel, RuleId } from '@/risk';

/**
 * A contact SOS can reach.
 *
 * `phone` is stored **normalized to E.164** (`+919876543210`) rather than as typed, because
 * both delivery paths need it that way and normalizing at the edge means nothing downstream
 * has to re-derive it. `src/sos/phone.ts` owns that conversion and the store rejects
 * anything it cannot normalize, so an unusable number cannot reach the send path.
 */
export type EmergencyContact = {
  readonly id: string;
  readonly name: string;
  readonly relation: string;
  /** E.164, including the leading `+`. */
  readonly phone: string;
};

/** A resolved position for the alert. Deliberately **not** rounded — see `sos/location.ts`. */
export type SosLocation = {
  readonly latitude: number;
  readonly longitude: number;
  /**
   * Radius of 68 % confidence in metres, as the OS reports it, or null when unknown.
   *
   * Carried into the message because it is the difference between a coordinate a responder
   * can act on and one that spans a neighbourhood. The app no longer blocks
   * `ACCESS_FINE_LOCATION` (see `app.json` and `src/environment/location.ts`), but the user may
   * still have granted only approximate location, in which case this is thousands of metres and
   * the message says so rather than implying a doorstep.
   */
  readonly accuracyM: number | null;
  readonly timestamp: number;
};

/** Why the position is missing, when it is. */
export type SosLocationFailure =
  | 'permission_denied'
  | 'services_disabled'
  | 'timeout'
  | 'unavailable';

/**
 * Outcome of resolving a position. An SOS is sent **with or without** a fix — a message
 * saying "location unavailable" still tells a contact to call, which is the whole point, so
 * a failed fix must never abort the alert.
 */
export type SosLocationResult =
  | { readonly ok: true; readonly location: SosLocation }
  | { readonly ok: false; readonly reason: SosLocationFailure };

/** Everything the message needs, gathered once so composition stays pure. */
export type SosContext = {
  /** Rules that triggered, from `RiskAssessment.criticalRules`. Empty for a manual press. */
  readonly criticalRules: readonly RuleId[];
  /** Worst level across categories, for the summary line. */
  readonly level: RiskLevel;
  /** Latest vitals, each optional exactly as `SensorReading` has them. */
  readonly vitals: {
    readonly hr?: number;
    readonly spo2?: number;
    readonly skinTempC?: number;
  };
  /** Ambient heat index in °C when known, for heat-triggered alerts. */
  readonly heatIndexC?: number | null;
  readonly location: SosLocationResult | null;
  /** Who the alert is about. Blank when the user has not set a name. */
  readonly userName?: string;
  /** Composition instant, epoch ms. Passed in — this module reads no clock. */
  readonly now: number;
  /** True when the user pressed the button rather than a rule firing. */
  readonly manual: boolean;
};

/** Which path delivered (or tried to). */
export type SosChannel = 'twilio' | 'native_sms';

/** Per-contact, per-channel result. */
export type SosDeliveryAttempt = {
  readonly contactId: string;
  readonly phone: string;
  readonly channel: SosChannel;
  readonly ok: boolean;
  /** Present when `ok` is false. Human-readable, for the UI and the audit line. */
  readonly error?: string;
};

/**
 * Result of one full dispatch.
 *
 * `nativeSmsPending` is the honest name for what the fallback actually achieves: an SMS
 * *intent* opens the platform composer pre-filled, and the user still has to press send.
 * Reporting that as `sent` would tell someone their emergency message went out when it is
 * sitting on screen unsent, so the two are distinct states everywhere.
 */
export type SosDispatchResult = {
  readonly attempts: readonly SosDeliveryAttempt[];
  /** Contacts the serverless Twilio path confirmed. */
  readonly twilioSent: readonly string[];
  /** True when the composer was opened as a fallback and needs a user tap. */
  readonly nativeSmsPending: boolean;
  /** True when no path produced anything at all. */
  readonly failed: boolean;
  /** The exact text that was sent, kept for the UI's "what was sent" disclosure. */
  readonly message: string;
};

/**
 * Phase of the SOS sequence (PRD §7.2.5's action sequence).
 *
 * `countdown` is the 30-second cancel window; `dispatching` is after it elapsed. There is no
 * transition from `dispatching` back to `countdown` — once the window closes the alert is
 * committed, because a second cancel opportunity mid-send would leave delivery ambiguous.
 */
export type SosPhase =
  | 'idle'
  | 'countdown'
  | 'dispatching'
  | 'sent'
  | 'sms_pending'
  | 'failed'
  | 'cancelled'
  /** Contact list is empty. A distinct state rather than a silent no-op, so the user finds
   *  out when a rule fires and not after an emergency. */
  | 'no_contacts'
  /** The PRD §7.2.6 opt-in is off. Also distinct: refusing to send is correct here, and
   *  saying nothing about it is not. */
  | 'no_consent';

/** A trigger, and what caused it. */
export type SosTrigger = {
  /** Stable identity of the firing rule set, so a cancel suppresses *this* emergency
   *  without deafening the app to a different one. See `machine.ts`. */
  readonly signature: string;
  readonly criticalRules: readonly RuleId[];
  readonly manual: boolean;
  /** When the countdown started, epoch ms. */
  readonly armedAt: number;
  /** When it fires, epoch ms — `armedAt + cancelWindowMs`. */
  readonly firesAt: number;
};
