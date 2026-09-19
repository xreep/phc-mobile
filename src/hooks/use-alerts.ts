/**
 * Wires the pure alert planner (`@/alerts/plan`) and the side-effect layer (`@/alerts/notify`)
 * into a screen (M3 alerts, workstream G). Same split as `useSos`: every decision — which
 * categories qualify, what the notification says — lives in a clock-free, framework-free module
 * that is unit-tested on its own; this hook is only the impure shell that calls it at the right
 * moment and hands the result to the OS.
 *
 * ## Permission comes from `AlertsProvider`, not from a private read here
 * This hook used to own a private `useState<AlertPermission>`, read once in a mount-only effect.
 * The Settings screen owned a second, independent copy the same way. Because Expo Router keeps
 * every tab mounted, granting the permission from Settings updated *Settings'* copy only — this
 * hook, mounted the whole time on the Dashboard tab, kept believing `'undetermined'` for the rest
 * of the process's life, so the gate below never opened on Android 13+ until the app was killed
 * and relaunched. `@/alerts/provider`'s `useAlertPermission()` fixes that by making the current
 * permission one piece of context state both places read — see that module's doc for the rest of
 * the reasoning, including why it also re-reads on `AppState` 'active' and when the Settings
 * toggle flips to enabled.
 *
 * ## Foreground-only, for now
 * The app's sensing is foreground-only until the foreground-service milestone (see
 * `docs/features/notifications.md`), so this hook only ever runs while its screen is mounted and
 * rendering — there is no background task re-arming it. `planAlerts` itself does not know or
 * care: when the foreground service lands, it will re-drive the same pure function from a
 * background task instead of this hook, unchanged.
 *
 * ## Why planning itself — not just delivery — is gated on `enabled && live && granted`
 * The obvious design gates only `deliverAlert` on those three, and always calls `planAlerts` so
 * the tracked state "keeps up". That is wrong here: `planAlerts` marks a category as notified
 * (setting `lastNotifiedAt`/`lastNotifiedLevel`) the instant it decides a notification is
 * *warranted*, regardless of whether one actually reached the user. If planning ran while
 * disabled, or before permission was granted, a genuine rise would silently start the category's
 * cooldown clock without the user ever seeing anything — and by the time alerts are turned on or
 * permission is granted, that category could be waiting out the rest of a 30-minute cooldown for
 * a notification that never happened. Freezing planning itself alongside delivery means
 * re-enabling behaves like a fresh look: whatever is currently elevated notifies once, exactly as
 * an initial evaluation does.
 *
 * ## Why `live` gates planning too — never notify on the simulated window
 * The simulated sensor window is a **weather-driven demo**, not a real person: its heat category
 * can turn red because the demo's synthetic humidity climbed, and nobody should get a push about
 * that. Beyond being pointless, planning against it is actively harmful to the *real* signal:
 * `planAlerts` has no notion of "this tick doesn't count", so a simulated red would consume that
 * category's rise-notification and start its cooldown, exactly as an unwanted-disabled tick would
 * (see above) — and if the user then switches to Health Connect and is genuinely at risk, the
 * category could already be "cooling down" from a demo reading that never should have counted.
 * Gating planning on `live` keeps the tracked state exclusively a history of real readings: a
 * switch from simulated back to live *resumes planning from the last trusted live state* (the
 * state a prior live tick left behind, frozen while `live` was false) — it is never reset to
 * `initialAlertState()`'s green, and it never incorporates a simulated reading either way.
 *
 * ## Why the planning effect depends on the gate, not only on `evaluatedAt`
 * `permission` starts `'undetermined'` on every mount and only resolves to a real value once
 * `AlertsProvider`'s own read completes. An effect keyed on `evaluatedAt` alone would evaluate
 * the first assessment against a gate that has not opened yet, see it blocked, and then never
 * look again until the *next* assessment happened to arrive — a category that was already red at
 * launch would wait for the following tick rather than notifying once permission (or `enabled`)
 * catches up. So `enabled`, `live`, and `permission` are real dependencies of the planning effect
 * alongside `evaluatedAt`: any of the four newly making the gate true re-evaluates the *current*
 * assessment, which is exactly the "treat it like a fresh look" behaviour the previous section
 * describes — and, since `permission` now comes from shared context, this is also what makes a
 * grant from the Settings screen reach this already-mounted hook without a remount. `assessment`
 * itself is still read from a ref rather than listed directly, because a parent re-render can
 * hand down a new-but-equal-content object between real changes, and only `evaluatedAt` is
 * defined to mean "the assessment actually advanced".
 */

import { useEffect, useRef } from 'react';

import { deliverAlert } from '@/alerts/notify';
import { initialAlertState, planAlerts, type AlertState } from '@/alerts/plan';
import { useAlertPermission } from '@/alerts/provider';
import type { RiskAssessment } from '@/risk';

export type UseAlertsInput = {
  readonly assessment: RiskAssessment;
  /** The Settings "Alert notifications" toggle. */
  readonly enabled: boolean;
  /** True when `assessment` was built from Health Connect rather than the simulated window —
   *  `DashboardRisk.live` from `useRiskAssessment`. See the module doc for why this gates
   *  planning, not only delivery. */
  readonly live: boolean;
};

export type UseAlertsOptions = {
  /** Injected in tests, same convention as `useSos`'s `*Impl` options. */
  readonly planImpl?: typeof planAlerts;
  readonly deliverImpl?: typeof deliverAlert;
  readonly cooldownMs?: number;
};

export function useAlerts(input: UseAlertsInput, options: UseAlertsOptions = {}): void {
  const deliver = options.deliverImpl ?? deliverAlert;
  const plan = options.planImpl ?? planAlerts;

  const { permission } = useAlertPermission();

  // Planner state lives in a ref, not `useState`: nothing here is rendered, and a plain object
  // mutated between ticks is exactly what `planAlerts` is built to consume as `previous`.
  const alertState = useRef<AlertState>(initialAlertState());

  // `assessment` is read fresh here rather than added to the effect's dependency array below —
  // see the module doc's last section for why only `evaluatedAt` should trigger a re-plan.
  // Assigned in a bare effect (no dependency array), so it never reads a discarded render's
  // object, the same discipline `useSos`'s `inputsRef` documents.
  const assessmentRef = useRef(input.assessment);
  useEffect(() => {
    assessmentRef.current = input.assessment;
  });

  const evaluatedAt = input.assessment.evaluatedAt;
  const { enabled, live } = input;

  useEffect(() => {
    // See the module doc: planning itself, not only delivery, is gated on all three — an
    // unwatched tick must not silently start a category's cooldown.
    if (!enabled || !live || permission !== 'granted') return;

    const { state, intents } = plan(alertState.current, assessmentRef.current, evaluatedAt, {
      cooldownMs: options.cooldownMs,
    });
    alertState.current = state;

    for (const intent of intents) {
      void deliver(intent);
    }
    // `plan`/`deliver`/`options.cooldownMs` are stable across a mount in every real caller;
    // `assessment` is deliberately read via the ref above rather than listed (see the module
    // doc's last section).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluatedAt, enabled, live, permission]);
}
