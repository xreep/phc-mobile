/**
 * The SOS sequence as a pure reducer (PRD §7.2.5).
 *
 * ## Why this is a reducer and not just `useState` in the hook
 * The sequence has real edges: a cancel must suppress *this* emergency without deafening the
 * app to the next one, a rule that stays true must not re-text every contact once a minute,
 * and once the 30-second window closes the alert is committed. Each of those is a rule about
 * transitions between states, and every one of them is a case where getting it wrong is
 * invisible in normal use and harmful in an emergency.
 *
 * Kept pure — no clock, no timers, no I/O, `now` passed in — for the same reason
 * `src/risk/assess.ts` is: the cancel window and the escalation are then testable at exact
 * instants without fake timers, including the 30-second boundary itself, which is the one
 * moment that actually matters.
 *
 * ## Suppression vs cooldown: two different problems
 * **Suppression** is the user saying "not this". It is keyed on the trigger signature and
 * lasts until that rule set stops firing, so cancelling a low-SpO2 alert does not also
 * silence a fall three minutes later.
 *
 * **Cooldown** is the machine refusing to repeat itself. `heat.stillness.critical` is true for
 * as long as the user is still, by construction — without a cooldown it would re-arm on every
 * 60-second evaluation tick forever. See {@link REDISPATCH_COOLDOWN_MS}.
 *
 * Both are needed. Suppression alone would let an uncancelled alert repeat every minute;
 * cooldown alone would make a cancel expire after five minutes and re-alarm someone who
 * already said no.
 */

import { CANCEL_WINDOW_MS, REDISPATCH_COOLDOWN_MS } from './config';
import type { RuleId } from '@/risk';
import type { SosDispatchResult, SosPhase, SosTrigger } from './types';

export type SosMachineState = {
  readonly phase: SosPhase;
  /** The armed alert while `phase` is `countdown` or `dispatching`; null otherwise. */
  readonly trigger: SosTrigger | null;
  /** Outcome of the last dispatch, for the result UI. */
  readonly result: SosDispatchResult | null;
  /** Signature the user cancelled. Cleared when that rule set stops firing. */
  readonly suppressedSignature: string | null;
  /** When the last trigger was handled — dispatched, or refused for lack of contacts or
   *  consent. Anchors the cooldown. */
  readonly handledAt: number | null;
  readonly handledSignature: string | null;
};

export const INITIAL_SOS_STATE: SosMachineState = Object.freeze({
  phase: 'idle',
  trigger: null,
  result: null,
  suppressedSignature: null,
  handledAt: null,
  handledSignature: null,
});

export type SosMachineConfig = {
  readonly cancelWindowMs: number;
  readonly cooldownMs: number;
};

export const DEFAULT_SOS_MACHINE_CONFIG: SosMachineConfig = Object.freeze({
  cancelWindowMs: CANCEL_WINDOW_MS,
  cooldownMs: REDISPATCH_COOLDOWN_MS,
});

export type SosEvent =
  /**
   * The world as of this evaluation tick. Sent on every risk re-evaluation, firing or not.
   *
   * `signature` is null when nothing critical is firing, which is what clears suppression —
   * without that, a cancelled alert would stay silenced even after the user recovered and a
   * fresh episode began.
   */
  | {
      readonly type: 'assess';
      readonly signature: string | null;
      readonly criticalRules: readonly RuleId[];
      readonly now: number;
      readonly hasContacts: boolean;
      readonly consent: boolean;
    }
  /** The user pressed the SOS button. */
  | {
      readonly type: 'manual';
      readonly now: number;
      readonly hasContacts: boolean;
      readonly consent: boolean;
    }
  /** Countdown clock advanced. Fires the alert when the window has elapsed. */
  | { readonly type: 'tick'; readonly now: number }
  /** The user cancelled inside the window. */
  | { readonly type: 'cancel'; readonly now: number }
  /** Delivery finished (successfully or not). */
  | { readonly type: 'dispatched'; readonly result: SosDispatchResult; readonly now: number }
  /** The user acknowledged a terminal state. */
  | { readonly type: 'dismiss' };

/**
 * Stable identity for a set of firing rules.
 *
 * Sorted, so the same emergency produces the same signature regardless of the order
 * `assessRisk` happened to list its rules in. Without the sort, a reordering between two
 * evaluation ticks would read as a *new* emergency and defeat both suppression and cooldown.
 */
export function triggerSignature(criticalRules: readonly RuleId[]): string | null {
  if (criticalRules.length === 0) return null;
  return [...criticalRules].sort().join('|');
}

/** Manual presses get a unique signature so a cancelled press never suppresses the next one —
 *  when someone presses that button twice, they mean it. */
function manualSignature(now: number): string {
  return `manual:${now}`;
}

const TERMINAL_PHASES: ReadonlySet<SosPhase> = new Set<SosPhase>([
  'sent',
  'sms_pending',
  'failed',
  'cancelled',
  'no_contacts',
  'no_consent',
]);

/** True while the sequence is committed and must not be re-entered from the outside. */
function isBusy(phase: SosPhase): boolean {
  return phase === 'countdown' || phase === 'dispatching';
}

function inCooldown(state: SosMachineState, signature: string, now: number, cooldownMs: number) {
  if (state.handledSignature !== signature || state.handledAt === null) return false;
  return now - state.handledAt < cooldownMs;
}

function arm(
  state: SosMachineState,
  signature: string,
  criticalRules: readonly RuleId[],
  manual: boolean,
  now: number,
  config: SosMachineConfig,
): SosMachineState {
  return {
    ...state,
    phase: 'countdown',
    result: null,
    trigger: {
      signature,
      criticalRules,
      manual,
      armedAt: now,
      firesAt: now + config.cancelWindowMs,
    },
  };
}

/** Record a trigger as dealt with, so the cooldown applies to refusals too — otherwise a
 *  user with no contacts gets the same "add a contact" alert every 60 seconds. */
function handled(state: SosMachineState, signature: string, now: number): SosMachineState {
  return { ...state, handledAt: now, handledSignature: signature };
}

/**
 * Advance the sequence.
 *
 * Returns the same object reference when nothing changed, so a `useReducer` caller does not
 * re-render on every ignored evaluation tick.
 */
export function sosReducer(
  state: SosMachineState,
  event: SosEvent,
  config: SosMachineConfig = DEFAULT_SOS_MACHINE_CONFIG,
): SosMachineState {
  switch (event.type) {
    case 'assess': {
      // Nothing critical is firing: clear suppression so a *later* episode of the same rule
      // can alert again. The cooldown anchor is deliberately left alone — it is time-based and
      // expires on its own.
      if (event.signature === null) {
        return state.suppressedSignature === null
          ? state
          : { ...state, suppressedSignature: null };
      }

      // An armed or in-flight alert already covers the emergency. Re-arming on a changed rule
      // set would restart the 30-second window and *delay* the alert — the opposite of what a
      // worsening situation calls for.
      if (isBusy(state.phase)) return state;

      if (state.suppressedSignature === event.signature) return state;
      if (inCooldown(state, event.signature, event.now, config.cooldownMs)) return state;

      // Consent first: PRD §7.2.6 makes the opt-in the gate on the only outbound path that
      // carries personal data, so a refusal here is visible rather than silent.
      if (!event.consent) {
        return handled({ ...state, phase: 'no_consent', trigger: null }, event.signature, event.now);
      }
      if (!event.hasContacts) {
        return handled(
          { ...state, phase: 'no_contacts', trigger: null },
          event.signature,
          event.now,
        );
      }

      return arm(state, event.signature, event.criticalRules, false, event.now, config);
    }

    case 'manual': {
      if (isBusy(state.phase)) return state;

      const signature = manualSignature(event.now);

      if (!event.consent) {
        return { ...state, phase: 'no_consent', trigger: null };
      }
      if (!event.hasContacts) {
        return { ...state, phase: 'no_contacts', trigger: null };
      }

      // No cooldown check. A cooldown exists to stop the *machine* repeating itself; applying
      // it to a deliberate press would refuse a person asking for help and say nothing useful
      // about why.
      return arm(state, signature, [], true, event.now, config);
    }

    case 'tick': {
      if (state.phase !== 'countdown' || state.trigger === null) return state;
      if (event.now < state.trigger.firesAt) return state;
      return { ...state, phase: 'dispatching' };
    }

    case 'cancel': {
      if (state.phase !== 'countdown' || state.trigger === null) return state;

      // A cancelled manual press is not suppressed — its signature is unique per press, so
      // nothing it could match will ever recur.
      return {
        ...state,
        phase: 'cancelled',
        suppressedSignature: state.trigger.manual ? state.suppressedSignature : state.trigger.signature,
        trigger: null,
      };
    }

    case 'dispatched': {
      if (state.phase !== 'dispatching') return state;

      const { result } = event;
      const phase: SosPhase = result.failed
        ? 'failed'
        : result.nativeSmsPending
          ? // Pending outranks sent: if any contact still needs a tap, the honest headline is
            // "waiting on you", even when the relay reached the others.
            'sms_pending'
          : 'sent';

      const signature = state.trigger?.signature ?? null;
      const next: SosMachineState = { ...state, phase, result, trigger: null };
      return signature === null ? next : handled(next, signature, event.now);
    }

    case 'dismiss': {
      if (!TERMINAL_PHASES.has(state.phase)) return state;
      // Suppression and the cooldown anchor survive dismissal — they describe what already
      // happened, and clearing them here would re-alarm immediately.
      return { ...state, phase: 'idle', result: null, trigger: null };
    }

    default: {
      // Exhaustiveness: a new event type becomes a compile error rather than a silent no-op in
      // the one module where a missed transition means an alert that never fires.
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** Milliseconds left in the cancel window, floored at zero. Zero when nothing is armed. */
export function countdownRemainingMs(state: SosMachineState, now: number): number {
  if (state.phase !== 'countdown' || state.trigger === null) return 0;
  return Math.max(0, state.trigger.firesAt - now);
}

/** Whole seconds to display. Rounded **up**, so a window with 1 ms left still reads "1" and
 *  the user never sees "0" while they can still cancel. */
export function countdownSeconds(state: SosMachineState, now: number): number {
  return Math.ceil(countdownRemainingMs(state, now) / 1000);
}
