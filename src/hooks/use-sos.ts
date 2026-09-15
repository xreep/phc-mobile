/**
 * Drives the SOS sequence for a screen (PRD §7.2.5).
 *
 * ## What lives here and what does not
 * The transition rules are in `src/sos/machine.ts`, pure and clock-free. This hook is only the
 * impure shell around them: the countdown timer, the vibration, the location fix, the network
 * call, and the wiring from `RiskAssessment.criticalRules` to an `assess` event. Everything
 * with a decision in it is testable without this hook; everything in this hook is a side
 * effect with no branching worth hiding.
 *
 * ## The evaluation instant comes from the assessment, not from a clock
 * `assess` events use `assessment.evaluatedAt` rather than a fresh `Date.now()`. The risk
 * engine already fixed an instant for that evaluation, and using a second, slightly later one
 * here would let the cooldown be computed against a different clock reading than the window
 * that produced the trigger. The countdown itself does read the real clock — it is measuring
 * elapsed wall time, which is the one thing that cannot be derived from the assessment.
 *
 * ## Why the dispatch effect has no cleanup
 * Once the cancel window closes, the alert is committed. An in-flight dispatch must finish and
 * report even if the screen unmounts, so the effect deliberately does not abort on cleanup —
 * it dedupes on the trigger identity instead. That ordering also survives React's
 * double-invoked effects in development, where an abort-on-cleanup version would either send
 * twice or wedge in `dispatching` forever.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Vibration } from 'react-native';

import { useSettings } from '@/settings/provider';
import { isSosEnabled } from '@/settings/store';
import type { RiskAssessment, SensorReading } from '@/risk';
import { COUNTDOWN_TICK_MS, isTwilioConfigured, LOCATION_TIMEOUT_MS } from '@/sos/config';
import { dispatchSos, type DispatchOptions } from '@/sos/deliver';
import { resolveSosLocation } from '@/sos/location';
import { describeCriticalRule } from '@/sos/message';
import {
  countdownSeconds,
  DEFAULT_SOS_MACHINE_CONFIG,
  INITIAL_SOS_STATE,
  sosReducer,
  triggerSignature,
  type SosEvent,
  type SosMachineConfig,
  type SosMachineState,
} from '@/sos/machine';
import type { EmergencyContact, SosContext, SosDispatchResult, SosPhase } from '@/sos/types';

/**
 * Vibration pattern for the local alert (PRD §7.2.5 step 1).
 *
 * Long-short-long, repeating, so it is distinguishable from a notification buzz by feel alone —
 * the user may be reading the countdown or may have the phone in a pocket. Android honours the
 * durations; iOS ignores them and fires a fixed-length buzz per element, which is a difference
 * in texture rather than in meaning.
 */
const ALERT_PATTERN = [0, 600, 250, 600, 250, 900];

export type UseSosInput = {
  readonly assessment: RiskAssessment;
  /** Newest reading, for the vitals line in the message. Null at cold start. */
  readonly latest: SensorReading | null;
  /**
   * Set when the caller already knows there is no data connection, so the relay is skipped and
   * the composer opens immediately (PRD §7.2.5's "no connectivity" branch).
   *
   * Left unset by default rather than inferred: guessing wrong in the pessimistic direction
   * skips a relay that would have worked and turns a delivered alert into one waiting for a
   * tap, which is the worse of the two errors. Guessing wrong the other way costs at most the
   * relay timeout before the composer opens anyway.
   */
  readonly offline?: boolean;
};

export type UseSosOptions = {
  readonly config?: SosMachineConfig;
  /** Injected in tests. */
  readonly dispatchImpl?: typeof dispatchSos;
  readonly resolveLocationImpl?: typeof resolveSosLocation;
  readonly nowImpl?: () => number;
  readonly vibrateImpl?: (pattern: readonly number[], repeat: boolean) => void;
  readonly cancelVibrationImpl?: () => void;
  readonly dispatchOptions?: DispatchOptions;
};

export type SosController = {
  readonly phase: SosPhase;
  /** Whole seconds left to cancel. 0 outside the window. */
  readonly secondsRemaining: number;
  /** True when the armed alert came from the button rather than a rule. */
  readonly manual: boolean;
  /**
   * Plain-language causes for the armed alert, deduplicated.
   *
   * Taken from the same table the SMS body uses, so the reason on screen during the cancel
   * window is verbatim the reason the contacts receive. Empty for a manual press.
   */
  readonly reasons: readonly string[];
  readonly result: SosDispatchResult | null;
  readonly contacts: readonly EmergencyContact[];
  /** Whether the primary relay is configured, so the UI can say the fallback will be used. */
  readonly relayConfigured: boolean;
  /** Press the SOS button. */
  readonly press: () => void;
  /** Cancel inside the window. */
  readonly cancel: () => void;
  /** Acknowledge a terminal state and return to idle. */
  readonly dismiss: () => void;
};

export function useSos(input: UseSosInput, options: UseSosOptions = {}): SosController {
  const { settings, loaded } = useSettings();
  const config = options.config ?? DEFAULT_SOS_MACHINE_CONFIG;

  const reducer = useCallback(
    (state: SosMachineState, event: SosEvent) => sosReducer(state, event, config),
    [config],
  );
  const [state, dispatch] = useReducer(reducer, INITIAL_SOS_STATE);

  const now = useCallback(() => (options.nowImpl ?? Date.now)(), [options.nowImpl]);

  // Everything the committed dispatch reads is mirrored into a ref, so the effect that runs it
  // can depend on `state.phase` alone. Adding these as dependencies would re-run a committed
  // send whenever a vital changed.
  //
  // Mirrored in an effect rather than assigned during render. `ref.current = x` in a render body
  // is what `react-hooks/refs` flags, and the reason is real: a render React discards would still
  // have moved the ref, so a committed dispatch could read values from a render that never
  // happened. This effect is declared *above* the dispatch effect and has no dependency array, so
  // it runs first in every commit — including the commit that turns the phase to `dispatching`,
  // which is the only one whose freshness matters. The `useRef` seeds cover the first render,
  // before any effect has run.
  const inputsRef = useRef(input);
  const contactsRef = useRef(settings.contacts);
  const userNameRef = useRef(settings.userName);

  useEffect(() => {
    inputsRef.current = input;
    contactsRef.current = settings.contacts;
    userNameRef.current = settings.userName;
  });

  const consent = isSosEnabled(settings);
  // `loaded` is part of the gate: before storage resolves, an empty contact list means "not
  // read yet", not "the user has nobody". Treating the two alike would report `no_contacts`
  // for a rule that fired in the first moments after launch.
  const hasContacts = loaded && settings.contacts.length > 0;

  // ---- Trigger intake -----------------------------------------------------
  const signature = triggerSignature(input.assessment.criticalRules);

  useEffect(() => {
    if (!loaded) return;
    dispatch({
      type: 'assess',
      signature,
      criticalRules: input.assessment.criticalRules,
      now: input.assessment.evaluatedAt,
      hasContacts,
      consent,
    });
  }, [
    loaded,
    signature,
    input.assessment.criticalRules,
    input.assessment.evaluatedAt,
    hasContacts,
    consent,
  ]);

  // ---- Countdown ----------------------------------------------------------
  // Held separately from the machine because the display has to update four times a second
  // while the machine's own state is deliberately unchanged until the window closes.
  const [clock, setClock] = useState(0);

  useEffect(() => {
    if (state.phase !== 'countdown') return;

    // No synchronous `setClock(now())` before the interval starts. It would be a cascading render
    // (`react-hooks/set-state-in-effect`) for no gain: the first frame's value already comes from
    // the `displayClock` floor below, which is `armedAt` — the full window, exactly what a
    // just-armed countdown should read.
    const timer = setInterval(() => {
      const instant = now();
      setClock(instant);
      dispatch({ type: 'tick', now: instant });
    }, COUNTDOWN_TICK_MS);

    return () => clearInterval(timer);
  }, [state.phase, now]);

  // ---- Local alert (PRD §7.2.5 step 1) ------------------------------------
  useEffect(() => {
    if (state.phase !== 'countdown') return;

    const vibrate = options.vibrateImpl ?? ((p: readonly number[], r: boolean) => Vibration.vibrate([...p], r));
    const stop = options.cancelVibrationImpl ?? (() => Vibration.cancel());

    vibrate(ALERT_PATTERN, true);
    return () => stop();
  }, [state.phase, options.vibrateImpl, options.cancelVibrationImpl]);

  // ---- Committed dispatch -------------------------------------------------
  const inFlightRef = useRef<string | null>(null);

  useEffect(() => {
    const trigger = state.trigger;
    if (state.phase !== 'dispatching' || trigger === null) return;

    const key = `${trigger.signature}@${trigger.armedAt}`;
    if (inFlightRef.current === key) return;
    inFlightRef.current = key;

    const contacts = contactsRef.current;
    const { assessment, latest, offline } = inputsRef.current;
    const userName = userNameRef.current;
    const resolveLocation = options.resolveLocationImpl ?? resolveSosLocation;
    const send = options.dispatchImpl ?? dispatchSos;

    void (async () => {
      const location = await resolveLocation({ timeoutMs: LOCATION_TIMEOUT_MS });

      const context: SosContext = {
        criticalRules: trigger.criticalRules,
        level: assessment.level,
        vitals: {
          hr: latest?.hr,
          spo2: latest?.spo2,
          skinTempC: latest?.skinTempC,
        },
        heatIndexC: assessment.heatIndexC,
        location,
        userName,
        now: now(),
        manual: trigger.manual,
      };

      const result = await send(contacts, context, {
        ...options.dispatchOptions,
        skipTwilio: offline === true || options.dispatchOptions?.skipTwilio === true,
      });

      dispatch({ type: 'dispatched', result, now: now() });
    })();
    // No cleanup: see the module header. A committed alert reports its outcome or nothing does.
  }, [
    state.phase,
    state.trigger,
    now,
    options.dispatchImpl,
    options.resolveLocationImpl,
    options.dispatchOptions,
  ]);

  // ---- Controls -----------------------------------------------------------
  const press = useCallback(() => {
    dispatch({ type: 'manual', now: now(), hasContacts, consent });
  }, [now, hasContacts, consent]);

  const cancel = useCallback(() => {
    dispatch({ type: 'cancel', now: now() });
  }, [now]);

  const dismiss = useCallback(() => {
    dispatch({ type: 'dismiss' });
  }, []);

  // Floor the display clock at `armedAt`, which serves two cases: the frame between arming and
  // the countdown effect's first tick (there is no synchronous seed — see the countdown effect),
  // and a stale `clock` left behind by a *previous* countdown, which is always older than a newly
  // armed trigger and so loses the `Math.max`.
  const displayClock = Math.max(clock, state.trigger?.armedAt ?? 0);
  const relayConfigured = useMemo(() => isTwilioConfigured(), []);

  const triggerRules = state.trigger?.criticalRules;
  const reasons = useMemo(
    () => (triggerRules === undefined ? [] : [...new Set(triggerRules.map(describeCriticalRule))]),
    [triggerRules],
  );

  return {
    phase: state.phase,
    secondsRemaining: countdownSeconds(state, displayClock),
    manual: state.trigger?.manual ?? false,
    reasons,
    result: state.result,
    contacts: settings.contacts,
    relayConfigured,
    press,
    cancel,
    dismiss,
  };
}
