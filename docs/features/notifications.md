# Local risk-change notifications (M3 alerts)

## Feature
Local (on-device) push notifications when a Tier-1 risk category's level rises into `amber` or
`red`, or a PRD §7.2.5 critical trigger newly appears — so a red card is not only visible to
someone actively looking at the Dashboard.

## Objective
PS 26181 / PRD §7.2.4–§7.2.5. Today the Tier-1 rule engine (`@/risk`) only speaks through the
Dashboard's cards: a category can turn `red` while the phone is in a pocket and nobody sees it
until the app is reopened. This feature gives the risk engine's own output a way to interrupt the
user — a system notification — without changing anything about how the engine itself decides
severity.

## Problem
A red card nobody is looking at is not an early warning. The engine already computes level, tier,
and `critical` every evaluation tick (`RiskAssessment`, `src/risk/types.ts`); nothing before this
feature turned any of that into something the user would notice while not looking at the screen.

## Architecture
Four pieces, deliberately kept separate so the decision logic is unit-testable without touching
`expo-notifications`:

```
RiskAssessment (from useRiskAssessment)          settings.alerts.enabled, AppState 'active'
        │                                                        │
        ▼                                                        ▼
  src/alerts/plan.ts                                  src/alerts/provider.tsx (AlertsProvider)
  pure: (previous state, assessment, now)             owns the one shared `permission` value —
  → (next state, intents[])                           reads it on mount, on foreground, and when
        │                                              the toggle flips to enabled
        ▼                                                        │
  src/hooks/use-alerts.ts ◄───────────────── useAlertPermission() ┘
  impure shell: calls plan() when evaluatedAt/enabled/live/permission change, calls deliver()
  for each intent
        │
        ▼
  src/alerts/notify.ts   — thin side-effect layer: channels, permission, scheduleNotificationAsync
```

- `src/app/_layout.tsx` mounts `AlertsProvider` once, inside `SettingsProvider` (it reads
  `settings.alerts.enabled`) and alongside `SensorProvider`. `src/app/index.tsx` (Dashboard) is
  the only screen that mounts `useAlerts`, wired to `useRiskAssessment`'s `assessment` and `live`,
  and to the Settings `alerts.enabled` flag; both it and `src/app/settings.tsx` call
  `useAlertPermission()` to read/request the one shared permission — see **Implementation** below
  for why a private copy in each place was a real bug, not a hypothetical one.
- `src/settings/store.ts` / `provider.tsx` / `src/app/settings.tsx` carry the one new persisted
  field, `alerts: { enabled: boolean }`, and the "Alert notifications" toggle, following the exact
  pattern the sensor-source and data-sharing settings already use (validate-on-read, a reducer in
  the provider, a `SettingRow` in the screen).
- Nothing here changes `@/risk`. The planner reads `RiskAssessment`/`CategoryAssessment` as already
  computed and adds no new rule semantics of its own.

## Implementation

### The planner (`src/alerts/plan.ts`)
`planAlerts(previous: AlertState, assessment: RiskAssessment, now: number, options?): { state, intents }`
is pure and clock-free (`now` is passed in, same discipline as `assessRisk`). It tracks, per
category, the last-seen level/critical flag and the last-notified level/instant, and applies:

| Rule | Behaviour |
| --- | --- |
| Rise into `amber`/`red` | Notifies immediately, no cooldown. `initialAlertState()` starts every category at `green`, so a category already `red` on the very first assessment reads as a rise — no special-casing for "first evaluation". |
| Critical flips `false → true` | Notifies immediately, **bypassing the cooldown**, even right after a same-level notification. |
| Same level, no rise, no new critical | Re-notifies only after `ALERT_COOLDOWN_MS` (30 min, overridable via `options.cooldownMs`) since that category's *last notification*. |
| Level falls | Never notifies. Resets the category's last-notified level so the next rise is treated fresh. |
| `dataQuality === 'missing' \| 'stale'` | Never notifies, and the category's tracked state is **frozen** for that tick — see the module doc in `plan.ts` for why updating it would let a stale reading silently consume a real rise. |

Intent shape: `{ category, level, critical, title, body, evaluatedAt }`. Title is
`"<Category> risk: elevated|high"` for a level rise or a same-level reminder, or a per-category
emergency phrase (`"Emergency: possible fall detected"`, etc.) **only on the tick where `critical`
itself flips `false → true`** — only `respiratory`, `fall`, and `heat` can ever report `critical:
true` (`CRITICAL_RULES` in `@/risk`). A later same-level reminder while `critical` merely *stays*
true (rule 3) uses the level phrase, not a second "Emergency": nothing new happened at that
instant, and repeating the word every cooldown period would both cry wolf and mislead about there
being a fresh event. The intent's own `critical` flag still mirrors the category's actual state
regardless of which rule fired, so `notify.ts` still routes an unresolved critical condition's
reminder to the high-urgency channel — only the *wording* is scoped to the flip. Body is the
category's own `guidance`, first sentence only.

### The OS layer (`src/alerts/notify.ts`)
Pinned against Expo SDK 57's `expo-notifications` (checked directly against the installed
package's `.d.ts` files, not memory of an earlier SDK — see the module's own header for the one
place this mattered: channel routing for an immediate notification is `trigger: { channelId }`,
not a `channelId` field on `content`, which does not exist on this SDK's
`NotificationContentInput`). Two Android channels:

| Channel | Importance | Vibration | Used for |
| --- | --- | --- | --- |
| `phc-alerts` | `HIGH` | OS default | Level rises and same-level reminders |
| `phc-critical` | `MAX` | Explicit pattern (`[0, 250, 250, 250]`) | PRD §7.2.5 critical triggers |

Every exported function (`ensureAlertChannels`, `requestAlertPermission`, `getAlertPermission`,
`deliverAlert`) is wrapped in try/catch. A missing native module, a denied permission, or an OS
quirk degrades to "no notification appears" — it must never throw into the Dashboard render.

### The permission provider (`src/alerts/provider.tsx`)
`AlertsProvider`/`useAlertPermission()` own the **one** shared `{ permission, refreshPermission,
requestPermission }`, mounted once in `_layout.tsx`. This exists because of a real bug caught in
review, not a hypothetical one: the first version of this feature had `useAlerts` read its own
private permission state in a mount-only effect, and the Settings screen kept a second,
independent copy of the same thing. Because Expo Router keeps every tab mounted, granting the
permission from Settings updated *Settings' own* copy only — the Dashboard's `useAlerts`, mounted
the whole time on the Dashboard tab, kept believing `'undetermined'` for the rest of the process's
life, so its delivery gate never opened on Android 13+ until the app was killed and relaunched.
Moving permission into one context fixes this the way React fixes any shared-state problem: both
consumers read the same value, so a change in one is a re-render in both. The provider also
re-reads permission (without prompting) on `AppState` `'active'` — the OS permission dialog itself
backgrounds and re-foregrounds the app, and a user who grants notifications from Android's own
settings app also returns here via a foreground transition — and whenever
`settings.alerts.enabled` flips from off to on, so the gate is current the moment it starts to
matter rather than only as fresh as the last foreground transition.

### The hook (`src/hooks/use-alerts.ts`)
`useAlerts({ assessment, enabled, live })` holds `AlertState` in a `useRef` (nothing here is
rendered), reads `permission` from `useAlertPermission()`, and re-runs the planner when
`assessment.evaluatedAt`, `enabled`, `live`, or `permission` change. **Planning itself — not only
delivery — is gated on `enabled && live && permission === 'granted'`.** This is the one
non-obvious decision in this workstream: the obvious design gates only `deliverAlert` and always
calls `planAlerts` so the tracked state "keeps up". That is wrong here, because `planAlerts` marks
a category notified (starting its cooldown) the instant it decides one is *warranted* — not when
one is actually shown. If planning ran while disabled, or before permission was granted, a genuine
rise would silently start a category's cooldown with the user never seeing anything, and turning
alerts on later could mean waiting out the rest of a 30-minute cooldown for a notification that
never happened. Gating planning itself means re-enabling (or permission being granted) re-evaluates
the *current* assessment fresh, exactly as an initial launch does — see `use-alerts.ts`'s module
doc for the full reasoning, including why `live` gates planning the same way (never let the
simulated demo window consume a real category's notification slot), and why making `permission` a
real effect dependency (rather than read once) is what lets a grant from the shared provider reach
this already-mounted hook without a remount.

### Never on the simulated window
`live` comes from `DashboardRisk.live` (`useRiskAssessment`), which is `true` only when readings
came from Health Connect. The simulated sensor window is weather-driven demo data — its heat
category can turn red because a synthetic humidity value climbed — and a push about that would be
a false alarm with no real person behind it. `live: false` freezes planning entirely for that
tick: the tracked state is left exactly as the last live tick left it, so switching from simulated
back to live data resumes planning **from the last trusted live state**, never from
`initialAlertState()`'s green and never incorporating a simulated reading either way.

### The Settings prompt for a fresh install
`DEFAULT_SETTINGS.alerts.enabled` is `true`, so a brand-new Android 13+ install can reach the
Alerts section with the toggle already on and the OS permission still `'undetermined'` — nobody
has been asked yet, and an undetermined permission renders no hint on its own (only `'denied'`
does). `src/app/settings.tsx` closes that gap: when `settings.alerts.enabled &&
alertPermission === 'undetermined'`, the screen shows a user-initiated "Turn on notifications"
row that calls the provider's `requestPermission()`, so the toggle's promise is actually kept
rather than silently waiting for some other prompt that may never come.

## Files
- `src/alerts/plan.ts`, `src/alerts/notify.ts`, `src/alerts/provider.tsx` — planner, OS layer, and
  the shared permission context.
- `src/alerts/__tests__/plan.test.ts`, `notify.test.ts`, `provider.test.tsx`, `fixtures.ts`.
- `src/hooks/use-alerts.ts`, `src/hooks/__tests__/use-alerts.test.ts`.
- `src/settings/store.ts`, `src/settings/provider.tsx`, `src/app/settings.tsx` — `alerts` field,
  `setAlertsEnabled`, the "Alerts" section (toggle + blocked notice + the fresh-install prompt).
- `src/app/_layout.tsx` — mounts `AlertsProvider` once, inside `SettingsProvider`.
- `src/app/index.tsx` — `useAlerts` wired into the Dashboard.
- `src/__tests__/home-screen.test.tsx`, `src/__tests__/simulate-fall.test.tsx` — wrapped in
  `<AlertsProvider>` now that `useAlerts` requires it.
- `jest/setup-after-env.js` — global `expo-notifications` mock.
- `app.json` — `expo-notifications` config plugin.

## Data Flow
`RiskAssessment` (already on-device, computed from sensor readings and the environment snapshot)
→ `planAlerts` (on-device, pure) → `deliverAlert` → `expo-notifications` → the Android system
tray. Nothing leaves the device. The notification body is the category's plain-language guidance
sentence (e.g. "Blood oxygen is below normal — sit upright, rest, and breathe slowly."), not a raw
number — see **Privacy** below for why that is a deliberate choice, not an incidental one.

## Tests
Unit tested (Jest) at every layer:
- `src/alerts/__tests__/plan.test.ts` — every rule in the table above, including the cooldown
  boundary on both sides, critical bypassing the cooldown, missing/stale never notifying (and not
  consuming a later real rise), falling-then-rising notifying again, the first-evaluation case, and
  that a same-level reminder titles with the level phrase — not a repeated "Emergency" — while
  `critical` merely stays true.
- `src/alerts/__tests__/notify.test.ts` — channel importance/vibration, permission-status mapping,
  channel routing by `critical`, and that every function swallows a thrown error.
- `src/alerts/__tests__/provider.test.tsx` — channels created and permission read once on mount;
  `requestPermission` updates the shared state; re-reads on `AppState` `'active'` (and not on other
  transitions); re-reads exactly on the Settings toggle's off→on transition (not on-stays-on or
  on→off).
- `src/hooks/__tests__/use-alerts.test.ts` — fake timers, `useAlertPermission` mocked so the
  returned `permission` can move between renders of the **same** hook instance; delivery gated on
  `enabled && live && permission === 'granted'`; never on the simulated window; exactly one
  delivery per intent; no re-plan when `evaluatedAt` is unchanged; a grant surfacing through the
  mocked provider delivers without a remount (the regression test for review round 1's CRITICAL
  #1); re-enabling (`enabled` transitioning false→true on the same instance) re-evaluates the
  current assessment; a toggle flip off-then-back-on inside the cooldown window does not duplicate
  an already-delivered notification.
- `src/settings/__tests__/store.test.ts` — `alerts` defaults, round-trip, and tolerance of an
  absent/malformed stored field.
- `src/__tests__/settings-screen.test.tsx` — the toggle persists, requests permission (through the
  real `AlertsProvider`, with `@/alerts/notify` mocked underneath it) only when turned on, shows
  the "blocked" notice when the OS permission is denied (both from a toggle press and from a
  permission already denied on load), and offers/hides the fresh-install "Turn on notifications"
  prompt correctly.
- `src/__tests__/home-screen.test.tsx`, `src/__tests__/simulate-fall.test.tsx` — wrap the Dashboard
  in `<AlertsProvider>` (alongside `SensorProvider`) now that `useAlerts` requires it; the global
  `expo-notifications` mock leaves permission `'undetermined'`, so these suites' assertions are
  unchanged from before this feature existed.

## Device Validation
**Device validated: NO.** Everything above is Unit tested / Integration tested (Jest) against the
project's own `expo-notifications` mock and against the real Notification-permission/channel type
definitions in the installed package — no test in this repository has run on a real Android
device, so the actual system-tray appearance, the real Android 13+ permission dialog, and real
vibration behaviour are unverified.

## Known Limitations
- **Foreground-only.** This hook only runs while the Dashboard screen is mounted and the app is in
  the foreground — there is no background task re-arming it, matching the rest of the app's
  sensing until the foreground-service milestone (`docs/ROADMAP.md`). `planAlerts` itself is
  already clock-free and state-driven, so that milestone can call it from a background task
  unchanged; only the shell around it (today, `use-alerts.ts`) needs to move.
- **Alert state does not persist across an app restart.** `AlertState` lives in a `useRef`, not in
  storage. A relaunch starts every category back at `initialAlertState()`'s green baseline, so a
  category that was already elevated before the restart will notify again as if it just rose. This
  was judged the safer default (a possibly-redundant notification, not a possibly-missed one) but
  is a real behaviour a human should be able to veto.
- **No per-category mute or quiet hours.** `AlertPrefs` is a record specifically so one can be
  added later without another schema-version bump, but nothing today lets a user silence one
  category (e.g. fatigue) while keeping others on.
- **iOS is unexercised.** The channel/importance model is Android-specific; iOS would need its own
  verification of the permission and delivery paths (`requestAlertPermission`/`getAlertPermission`
  already return the SDK's cross-platform three-state result, so the planner and hook need no
  change, but nothing here has run on iOS).
- **A tap does not deep-link yet.** `deliverAlert` carries `category` in `data` but nothing reads
  it on notification tap.
- **An environment-only change can be planned up to 60 seconds late.** `useRiskAssessment` re-reads
  `Date.now()` on a 60 s tick (`RE_EVALUATE_INTERVAL_MS`); a fresh sensor poll advances the
  evaluation instant sooner, but a heat category that turns `red` purely because the weather
  observation changed — with no new sensor reading in between — only produces a new
  `assessment.evaluatedAt` (and so a new planner tick) on the next 60 s boundary. This is inherited
  from `useRiskAssessment`, which this workstream does not modify (audit KEEP), and is a delay
  bound, not a missed notification: the next tick still catches it.

## Security
- **`android.permission.POST_NOTIFICATIONS`** (Android 13+). Declared in
  `node_modules/expo-notifications/android/src/main/AndroidManifest.xml` and merged into the app's
  manifest by Android's own manifest merger at native build time — **not** by the config-plugin
  `permissions` array in `app.json` (that array only lists permissions the *app* explicitly
  requests, e.g. Health Connect's). Verified directly: `npx expo config --type prebuild | grep -i
  POST_NOTIFICATIONS` prints **nothing**, because that command only reflects the app.json-driven
  permissions list — it does not run the native manifest merge. The permission's actual source was
  confirmed by reading the library's own manifest:
  ```
  $ grep -n permission node_modules/expo-notifications/android/src/main/AndroidManifest.xml
  2:  <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
  3:  <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
  ```
  The permission is never requested implicitly — `requestAlertPermission()` only ever runs from a
  direct user tap (the Settings toggle's `onValueChange`, or the fresh-install "Turn on
  notifications" row), per the brief's "user-initiated only" requirement.
- `ensureAlertChannels()` is called from exactly one place — `AlertsProvider`'s mount effect — not
  from both the hook and the Settings screen as an earlier version of this feature had it. Android
  channels are idempotent to recreate, so the duplicate call was harmless, but one owner is the
  simpler invariant to keep true.
- No new network calls, no new storage of health data. `deliverAlert`'s only external call is
  `expo-notifications`' local `scheduleNotificationAsync`.

## Privacy
The notification body is the category's plain-language `guidance` sentence (e.g. "Heart rate is
high — if you are not exercising, stop and rest."), **never a raw vital number**. This was a
deliberate choice, not an oversight: Android shows a notification's title and body on the lock
screen by default, which anyone glancing at the phone can read, and a bpm or SpO₂ figure there is a
more specific health disclosure than "your heart rate is elevated" is. Recommendation for the
notification-settings milestone: keep the lock-screen preview to guidance text only, and if a
numeric vital is ever added to a notification, gate it behind the same kind of explicit opt-in
`sharing` already uses for SOS (`src/settings/store.ts`), not the plain `alerts.enabled` toggle.

## Future Improvements
- Foreground-service milestone (`docs/ROADMAP.md`): re-drive `planAlerts` from a background task
  instead of `use-alerts.ts`, unchanged.
- Persist `AlertState` (or at least `lastNotifiedAt`/`lastNotifiedLevel`) so a relaunch does not
  reset every category's cooldown.
- Tap-to-deep-link into the relevant risk card using the `category` already carried in
  `data`.
- Per-category mute / quiet hours on top of the existing `AlertPrefs` record.

## Status
Built · Unit tested · Integration tested (Jest) — **not device validated**.

---

## Proposed status-doc updates

*(For the controller to merge into the shared docs this workstream must not edit directly.)*

### `docs/JUDGE_QA.md` entry
**Q: Does the app notify you if a risk goes critical while you're not looking at it?**
A: Yes, foreground-only for now. A rise into elevated/high risk, or a critical trigger such as a
possible fall, raises a local Android notification while the app is open in the background —
never on the demo/simulated data, only on live Health Connect readings, and only if you've kept
the "Alert notifications" toggle on in Settings. It reuses the exact same rule engine that drives
the Dashboard cards, so the notification and the card can never disagree. Not yet device-validated,
and not yet running when the app is fully closed (see Known Limitations above).

### `CHANGELOG.md` fragment
```
### Added
- Local notifications when a risk category rises to elevated/high or a critical trigger appears
  (`src/alerts/`, `src/hooks/use-alerts.ts`), with a new "Alerts" section and toggle in Settings.
  Foreground-only; not device validated. See `docs/features/notifications.md`.
```

### `docs/BUILD_MATRIX.md` row(s)
| Feature | Built | Unit tested | Integration tested | Device validated | Notes |
| --- | --- | --- | --- | --- | --- |
| Local risk-change notifications | ✅ | ✅ | ✅ (Jest) | ❌ | Foreground-only; Android channels/permission unverified on a real device |
