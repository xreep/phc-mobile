/**
 * Wires the pure alert planner (`@/alerts/plan`) and the side-effect layer (`@/alerts/notify`)
 * into a screen (M3 alerts, workstream G). Same split as `useSos`: every decision — which
 * categories qualify, what the notification says — lives in a clock-free, framework-free module
 * that is unit-tested on its own; this hook is only the impure shell that calls it at the right
 * moment and hands the result to the OS.
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
 * Gating planning on `live` keeps the tracked state exclusively a history of real readings, so a
 * switch from simulated to live starts that category's history from a clean, honest baseline
 * (`initialAlertState()`'s green) rather than from demo noise.
 *
 * ## Why the planning effect depends on the gate, not only on `evaluatedAt`
 * `permission` starts `'undetermined'` on every mount and only resolves to a real value after
 * the async permission read completes — one render after the assessment the screen mounted with
 * is already known. An effect keyed on `evaluatedAt` alone would evaluate that first assessment
 * against a gate that has not opened yet, see it blocked, and then never look again until the
 * *next* assessment happened to arrive — a category that was already red at launch would wait for
 * the following tick rather than notifying once permission (or `enabled`) catches up. So
 * `enabled`, `live`, and `permission` are real dependencies of the planning effect alongside
 * `evaluatedAt`: any of the four newly making the gate true re-evaluates the *current* assessment,
 * which is exactly the "treat it like a fresh look" behaviour the previous section describes.
 * `assessment` itself is still read from a ref rather than listed directly, because a parent
 * re-render can hand down a new-but-equal-content object between real changes, and only
 * `evaluatedAt` is defined to mean "the assessment actually advanced".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { initialAlertState, planAlerts, type AlertState } from '@/alerts/plan';
import {
  deliverAlert,
  ensureAlertChannels,
  getAlertPermission,
  requestAlertPermission,
  type AlertPermission,
} from '@/alerts/notify';
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
  readonly ensureChannelsImpl?: typeof ensureAlertChannels;
  readonly getPermissionImpl?: typeof getAlertPermission;
  readonly requestPermissionImpl?: typeof requestAlertPermission;
  readonly cooldownMs?: number;
};

export type AlertsController = {
  readonly permission: AlertPermission;
  /** Raises the OS permission prompt. User-initiated only — call this from a press handler,
   *  never from an effect, or the dialog appears unprompted (see `notify.ts`'s module doc). */
  readonly requestPermission: () => void;
};

export function useAlerts(input: UseAlertsInput, options: UseAlertsOptions = {}): AlertsController {
  const ensureChannels = options.ensureChannelsImpl ?? ensureAlertChannels;
  const readPermission = options.getPermissionImpl ?? getAlertPermission;
  const askPermission = options.requestPermissionImpl ?? requestAlertPermission;
  const deliver = options.deliverImpl ?? deliverAlert;
  const plan = options.planImpl ?? planAlerts;

  const [permission, setPermission] = useState<AlertPermission>('undetermined');

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

  // Channels must exist before the OS will even offer the Android 13+ permission prompt
  // (`docs/features/notifications.md` records the verification), and reading the current
  // permission on mount is what lets the Settings screen and this hook agree on state without
  // either one guessing. Both are best-effort: `ensureAlertChannels` already swallows its own
  // failures, and a failed read just leaves `permission` at its safe 'undetermined' default.
  useEffect(() => {
    void ensureChannels();
    void readPermission().then(setPermission);
    // Intentionally mount-only: channels do not need recreating, and the permission is otherwise
    // refreshed by `requestPermission` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requestPermission = useCallback(() => {
    void askPermission().then(setPermission);
  }, [askPermission]);

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

  return { permission, requestPermission };
}
