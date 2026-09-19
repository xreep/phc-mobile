/**
 * Pure planner for local risk-change notifications (M3 alerts).
 *
 * A red card nobody is looking at is not an early warning — the Dashboard only speaks when
 * someone is looking at it. This module decides *when a category's change is worth interrupting
 * someone for*, from the assessment alone; it has no side effects, no clock of its own (`now` is
 * passed in, same discipline as `@/risk`), and no knowledge that `expo-notifications` exists.
 * `src/alerts/notify.ts` is the only place that talks to the OS, and `src/hooks/use-alerts.ts` is
 * the only place that decides *whether* delivery is currently allowed (permission, the Settings
 * toggle, and — critically — never on the simulated demo window). Keeping this file pure is what
 * makes every rule below unit-testable without mocking a notification API.
 *
 * ## The rules (brief §2)
 * 1. **Rising into amber or red.** A category's level increasing from a lower level to `amber`
 *    or `red` always notifies, immediately, with no cooldown. `initialAlertState()` starts every
 *    category at `green`, so a category that is already `red` on the very first assessment reads
 *    as a rise like any other — the "first evaluation" case needs no special-casing.
 * 2. **A critical trigger appearing.** `critical` flipping `false → true` always notifies,
 *    immediately, even if a same-level notification fired a moment ago. This is deliberately a
 *    separate condition from the level rule: a category can already be `red` (and cooled down)
 *    when a critical trigger (PRD §7.2.5) fires on top of it, and that must not wait. Only *this*
 *    tick's notification gets the "Emergency: …" title (see `buildIntent`) — a later same-level
 *    reminder while `critical` merely *stays* true (rule 3, below) is not a second fall, and
 *    saying "Emergency" again every cooldown period would both cry wolf and mislead: nothing new
 *    happened at that instant, the first emergency is simply still unresolved.
 * 3. **A same-level repeat.** A category sitting at `amber` or `red` with no rise and no new
 *    critical flip re-notifies only after `cooldownMs` (default {@link ALERT_COOLDOWN_MS}, 30
 *    minutes) has elapsed since the *last notification for that category* — not since the level
 *    was first reached. This is the "still red after half an hour" reminder.
 * 4. **Falling levels never notify.** Nobody needs a push telling them the danger passed; the
 *    Dashboard already says so on next open. A fall resets `lastNotifiedLevel` to `null`, which
 *    matters for bookkeeping even though every reachable re-rise already renotifies under rule 1
 *    (rank comparison is against the *previous tick's* level, not the last-notified one) — see
 *    the state-shape note below for why the field still exists.
 * 5. **`dataQuality: 'missing' | 'stale'` never notifies**, and — this is the part a naive
 *    implementation gets wrong — the category's tracked state is left **untouched** for that
 *    tick rather than updated to the (untrustworthy) level. Updating it would let a stale `red`
 *    quietly consume the rise: data quality recovers a minute later, the level is still `red`,
 *    and a same-level-vs-previous-tick comparison would see no change and say nothing — the one
 *    tick where the trustworthy reading actually arrived would be silent. Freezing the state
 *    instead means the recovered reading is compared against the last *trusted* level, so the
 *    rise is still reported once data is usable again.
 *
 * ## Why `AlertState` carries both a tracked level and a last-notified level
 * `level`/`critical` are "what the previous *tick* reported", which is what rules 1 and 2 diff
 * against. `lastNotifiedAt`/`lastNotifiedLevel` are "what we last actually told the user", which
 * is what rule 3's cooldown keys off. They can only diverge while a category sits at an elevated
 * level without notifying (mid-cooldown), and diverge is exactly what has to happen there: the
 * tracked level keeps moving so rises are still detected, while the notified level and clock
 * stay frozen so the cooldown counts from the last real notification.
 */

import { CATEGORY_LABELS, type CategoryAssessment, type RiskAssessment, type RiskCategoryKey, type RiskLevel } from '@/risk';

/** Default same-level repeat cooldown (brief §2, rule 3). 30 minutes. */
export const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

/** Every category the engine produces, in the Dashboard's own order. Kept here rather than
 *  re-derived from `CATEGORY_LABELS` at every call so `initialAlertState()` is one allocation. */
const CATEGORY_KEYS: readonly RiskCategoryKey[] = Object.keys(CATEGORY_LABELS) as RiskCategoryKey[];

const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = { green: 0, amber: 1, red: 2 };

/** Plain-language word for a title, distinct from the card's own "amber"/"red" colour names —
 *  a lock-screen banner is not a place to teach someone the app's colour vocabulary. */
const LEVEL_WORD: Readonly<Record<'amber' | 'red', string>> = {
  amber: 'elevated',
  red: 'high',
};

/**
 * Emergency copy for a critical trigger, per category. Only `respiratory`, `fall`, and `heat`
 * can ever report `critical: true` — {@link CRITICAL_RULES} in `@/risk` fixes that set — so the
 * fallback below is unreachable today and exists only so a future critical category fails safe
 * (a generic emergency title) rather than crashing the planner.
 */
const CRITICAL_TITLE: Readonly<Partial<Record<RiskCategoryKey, string>>> = {
  respiratory: 'Emergency: critically low oxygen',
  fall: 'Emergency: possible fall detected',
  heat: 'Emergency: possible heat collapse',
};

function criticalTitle(key: RiskCategoryKey): string {
  return CRITICAL_TITLE[key] ?? `Emergency: ${CATEGORY_LABELS[key]}`;
}

/** First sentence of a guidance string, inclusive of its period. Every guidance string in
 *  `@/risk/rules` is currently one sentence, so this is a no-op today; it exists so a future
 *  multi-sentence guidance string cannot put a second sentence's worth of detail on a lock
 *  screen, where the privacy note in `docs/features/notifications.md` says only the headline
 *  belongs. */
function firstSentence(guidance: string): string {
  const match = /^[^.]*\./.exec(guidance);
  return match ? match[0] : guidance;
}

/** Per-category tracked state. See the module doc for why the two halves can diverge. */
export type AlertCategoryState = {
  readonly level: RiskLevel;
  readonly critical: boolean;
  readonly lastNotifiedAt: number | null;
  readonly lastNotifiedLevel: RiskLevel | null;
};

export type AlertState = {
  readonly byCategory: Readonly<Record<RiskCategoryKey, AlertCategoryState>>;
};

const INITIAL_CATEGORY_STATE: AlertCategoryState = {
  level: 'green',
  critical: false,
  lastNotifiedAt: null,
  lastNotifiedLevel: null,
};

/** Starting state: every category at green, uncritical, never notified. */
export function initialAlertState(): AlertState {
  return {
    byCategory: Object.fromEntries(CATEGORY_KEYS.map((key) => [key, INITIAL_CATEGORY_STATE])) as Readonly<
      Record<RiskCategoryKey, AlertCategoryState>
    >,
  };
}

/** One notification's content, independent of how it is delivered. */
export type AlertIntent = {
  readonly category: RiskCategoryKey;
  readonly level: RiskLevel;
  readonly critical: boolean;
  readonly title: string;
  readonly body: string;
  /** The assessment's own `evaluatedAt`, not the wall clock the planner was called with — so a
   *  delivered notification always names the instant its reading was actually taken. */
  readonly evaluatedAt: number;
};

export type PlanAlertsOptions = {
  /** Overrides {@link ALERT_COOLDOWN_MS}, for tests. */
  readonly cooldownMs?: number;
};

export type PlanAlertsResult = {
  readonly state: AlertState;
  readonly intents: readonly AlertIntent[];
};

/**
 * `criticalFlipped` — whether *this tick's* notification is the critical trigger newly
 * appearing (rule 2), as opposed to a level rise (rule 1) or a same-level reminder (rule 3) that
 * happens to have `cat.critical` still `true` from an earlier tick. Only the former gets the
 * "Emergency: …" title; the intent's own `critical` flag still mirrors `cat.critical` regardless
 * (`notify.ts` routes on it), so an unresolved critical condition's periodic reminder still
 * reaches the high-urgency channel — it is only the wording that must not cry wolf twice.
 */
function buildIntent(cat: CategoryAssessment, evaluatedAt: number, criticalFlipped: boolean): AlertIntent {
  const title = criticalFlipped
    ? criticalTitle(cat.key)
    : `${CATEGORY_LABELS[cat.key]} risk: ${LEVEL_WORD[cat.level as 'amber' | 'red']}`;

  return {
    category: cat.key,
    level: cat.level,
    critical: cat.critical,
    title,
    body: firstSentence(cat.guidance),
    evaluatedAt,
  };
}

/**
 * Decide which categories deserve a notification on this tick, and return the updated state to
 * carry into the next call. See the module doc for the five rules this implements.
 */
export function planAlerts(
  previous: AlertState,
  assessment: RiskAssessment,
  now: number,
  options: PlanAlertsOptions = {},
): PlanAlertsResult {
  const cooldownMs = options.cooldownMs ?? ALERT_COOLDOWN_MS;

  const nextByCategory: Record<RiskCategoryKey, AlertCategoryState> = { ...previous.byCategory };
  const intents: AlertIntent[] = [];

  for (const cat of assessment.categories) {
    const prev = previous.byCategory[cat.key] ?? INITIAL_CATEGORY_STATE;

    // Rule 5: untrustworthy data — freeze the tracked state, notify nothing, move on.
    if (cat.dataQuality === 'missing' || cat.dataQuality === 'stale') {
      continue;
    }

    const criticalFlipped = cat.critical && !prev.critical;
    const roseIntoElevated =
      LEVEL_RANK[cat.level] > LEVEL_RANK[prev.level] && cat.level !== 'green';
    const sameLevelCooldownElapsed =
      (cat.level === 'amber' || cat.level === 'red') &&
      cat.level === prev.level &&
      prev.lastNotifiedAt !== null &&
      now - prev.lastNotifiedAt >= cooldownMs;

    const shouldNotify = criticalFlipped || roseIntoElevated || sameLevelCooldownElapsed;

    if (shouldNotify) {
      intents.push(buildIntent(cat, assessment.evaluatedAt, criticalFlipped));
    }

    const fell = LEVEL_RANK[cat.level] < LEVEL_RANK[prev.level];

    nextByCategory[cat.key] = {
      level: cat.level,
      critical: cat.critical,
      lastNotifiedAt: shouldNotify ? now : prev.lastNotifiedAt,
      // Rule 4: a fall clears the last-notified level even though it did not itself notify;
      // otherwise carry forward, and set it fresh when this tick did notify.
      lastNotifiedLevel: shouldNotify ? cat.level : fell ? null : prev.lastNotifiedLevel,
    };
  }

  return { state: { byCategory: nextByCategory }, intents };
}
