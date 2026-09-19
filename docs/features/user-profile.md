# User profile ("About you")

> `docs/features/README.md` (the shared 14-heading template `common.md` points to) did not
> exist in this worktree at the time of writing. The headings below are this workstream's own
> reasonable equivalent; if the controller lands a real template afterwards, this doc should be
> reshaped to match it.

## 1. Status

Shipped (workstream D1, branch `feat/user-profile`). Schema, persistence, and Settings UI are
complete and tested. The engine wiring described in ADR-005 is explicitly **not** part of this
workstream and has not started.

## 2. Summary

Adds a minimal, locally-stored user profile — age band, chronic condition, outdoor worker,
pregnant — captured through a new "About you" section in Settings. A pure
`vulnerabilityFactors(profile)` / `isVulnerable(profile)` helper classifies the profile, but
nothing in the app currently reads that classification: this workstream is a proven no-op for
the risk engine (see §6).

## 3. Objective / problem

PS §3d asks for high-risk notifications for vulnerable individuals; the PRD's personas include
elderly users, people with a chronic condition, and outdoor workers. Before this workstream,
the app had no notion of who the user is, so it could not distinguish these personas. Applying
that information to risk *thresholds* is a health-methodology decision reserved for a future,
human-reviewed milestone (ADR-005) — this workstream only builds the capture path.

## 4. Design

- `src/settings/profile.ts` (pure, no I/O): `AgeBand`, `UserProfile`, `DEFAULT_PROFILE`,
  `AGE_BANDS` (the picker's label list), `parseProfile(unknown): UserProfile` (validate-on-read,
  same pattern as `src/settings/store.ts` — malformed or missing fields fall back to their
  individual defaults), `VulnerabilityFactor`, `vulnerabilityFactors(profile)`,
  `isVulnerable(profile)`.
- `src/settings/store.ts`: `PersistedSettings.profile: UserProfile`, defaulted in
  `DEFAULT_SETTINGS`, parsed via `parseProfile` inside `parseSettings` (an old stored blob with
  no `profile` key loads with `DEFAULT_PROFILE`, tested explicitly). `SETTINGS_KEY` was **not**
  bumped — the schema addition is additive and old blobs keep loading. A pure reducer
  `setProfile(settings, patch: Partial<UserProfile>)` merges a patch into the existing profile,
  matching the shape of the existing `setSharingPref`.
- `src/settings/provider.tsx`: `SettingsStore.setProfile(patch: Partial<UserProfile>)`, wired to
  the `setProfile` reducer through the same persist-on-change effect every other field uses.
- `src/app/settings.tsx`: a new "About you" section, positioned above "Data sharing" (below "How
  SOS sends"), consisting of an age-band picker built the same way as the existing sensor-source
  picker (`Pressable` + `accessibilityRole="radio"` + the same radio-dot visual), and three
  `Switch` rows for chronic condition, outdoor worker, and pregnant. The card opens with:
  "Used to tailor risk warnings on this phone. Never sent anywhere."
- **Explicitly untouched:** `src/risk/`, `src/hooks/use-risk-assessment.ts`, the Dashboard
  (`src/app/index.tsx`). No rule, threshold, or `RiskAssessment` field reads the profile.

## 5. Files changed

- `src/settings/profile.ts` (new)
- `src/settings/__tests__/profile.test.ts` (new)
- `src/settings/store.ts` (extended: `profile` field, `parseSettings`, `setProfile` reducer)
- `src/settings/__tests__/store.test.ts` (extended)
- `src/settings/provider.tsx` (extended: `setProfile`)
- `src/app/settings.tsx` (extended: "About you" section)
- `src/__tests__/settings-screen.test.tsx` (extended)
- `src/__tests__/home-screen.test.tsx` (extended: regression suite, see §6)
- `src/hooks/__tests__/use-risk-assessment.test.ts` (mechanical fix: the mocked `SettingsStore`
  object needed a `setProfile: jest.fn()` to satisfy the widened interface — no behavioural
  change)
- `docs/decisions/ADR-005-personalisation-inputs-before-thresholds.md` (new)

## 6. Tests

- `src/settings/__tests__/profile.test.ts` — `DEFAULT_PROFILE`, `AGE_BANDS` ordering,
  `parseProfile` against hostile/malformed input (non-object, unknown age band, non-boolean
  truthy values, missing fields, extra fields), `vulnerabilityFactors`/`isVulnerable` per factor
  and combined.
- `src/settings/__tests__/store.test.ts` — default profile, round-trip with a populated profile,
  an old blob with **no** `profile` key at all loading with defaults (the compatibility case),
  a malformed `profile` field defaulting without disturbing the rest of the blob, and the
  `setProfile` reducer (patch semantics, immutability, leaves the rest of settings alone).
- `src/__tests__/settings-screen.test.tsx` ("about you" describe block) — the privacy copy
  renders, every toggle defaults off, the age band persists and is mutually exclusive, each
  toggle persists independently, and a saved profile survives a remount.
- `src/__tests__/home-screen.test.tsx` ("profile is a no-op for the risk engine" describe block)
  — **the regression proof**: seeds `SETTINGS_KEY` with every `vulnerabilityFactors` factor
  turned on (`ageBand: '60plus'`, `chronicCondition: true`, `outdoorWorker: true`,
  `pregnant: true`) ahead of render, then re-asserts the exact same category statuses, guidance
  text, metrics, vitals, and baseline deltas as the default-profile tests earlier in the same
  file. Any future change that accidentally wires the profile into `src/risk/` breaks this test.

Commands and output tails are in the workstream report
(`profile-report.md`, written alongside this doc's brief).

## 7. How to verify

```
npm ci
npx jest src/settings/__tests__/profile.test.ts src/settings/__tests__/store.test.ts \
  src/__tests__/settings-screen.test.tsx src/__tests__/home-screen.test.tsx
npm test
npx tsc --noEmit
npx eslint src --max-warnings 0
```

## 8. Validation status

Device validated: NO. Unit tested / Integration tested (Jest) only, on the fixtures and mocks
already in the repository (AsyncStorage jest mock, `@testing-library/react-native`). No
accuracy, false-positive, or battery claim is made anywhere in this feature or its docs.

## 9. Decisions a human should be able to veto

- **No threshold or rule change.** This is the central, deliberate scope cut — see ADR-005. If
  the reviewer wants personalisation applied immediately instead of deferred, that overrides
  this workstream's design.
- **`SETTINGS_KEY` was not bumped.** The new `profile` field is additive and tolerated as
  missing by `parseSettings`, so existing installs keep their settings. If a reviewer would
  rather force a clean migration, that is a different, reversible choice.
- **Age band is a single choice, not multi-select**, and pregnancy/chronic-condition are plain
  booleans with no detail (e.g. no condition type). This keeps the schema small for a
  capture-only milestone; a reviewer designing the next milestone's methodology may want more
  granularity, which would be a schema change on top of this one.
- **"About you" was placed between "How SOS sends" and "Data sharing"** in the Settings screen,
  per the brief's "above the sharing prefs." A reviewer may prefer a different position (e.g.
  nearer "Your name").
- **The regression test asserts on rendered strings rather than serialising the whole
  `RiskAssessment` object.** This mirrors the existing "Home dashboard" test style in the same
  file, but a reviewer who wants a stricter guarantee (e.g. a snapshot of the full assessment
  object) may prefer to add one.

## 10. Known limitations

- The profile is not surfaced anywhere except Settings — there is no confirmation banner, no
  onboarding prompt, and no indication elsewhere in the app that a profile has been saved.
- A single `chronicCondition` boolean cannot distinguish condition types (asthma vs. heart vs.
  diabetes), which the Settings copy names as examples but does not capture individually. Any
  future condition-specific threshold work needs a schema change first.
- `vulnerabilityFactors`/`isVulnerable` are exported but currently have no caller anywhere in
  the app outside their own tests — they exist for the next milestone to use.

## 11. Security & privacy

No raw or derived profile data leaves the device — it is stored locally via the same
`AsyncStorage`-backed settings store as the rest of Settings (SQLCipher-backed storage is the
documented target per `CLAUDE.md`; this workstream did not change the storage backend). The
profile is never included in the SOS payload (`src/sos/`) or any network request. The Settings
copy states this plainly: "Used to tailor risk warnings on this phone. Never sent anywhere."

## 12. Non-goals / out of scope

- Applying the profile to any risk threshold, rule, or score (ADR-005, next milestone).
- A condition-type taxonomy beyond a single boolean.
- Any change to `src/risk/`, `src/hooks/use-risk-assessment.ts`, or the Dashboard.
- The TFLite ML layer (later phase per `CLAUDE.md`'s build order) — this workstream's data is a
  candidate input for that phase's design, not a dependency of it.

## 13. Related docs

- `docs/decisions/ADR-005-personalisation-inputs-before-thresholds.md` — the decision record
  this workstream implements the "capture" half of.
- `src/settings/store.ts` module header — the validate-on-read pattern this workstream extends.
- `src/sos/phone.ts` — the pure-module-with-tests pattern `src/settings/profile.ts` follows.

## 14. Proposed status-doc updates

The controller owns `docs/PROJECT_STATUS.md`, `docs/BUILD_MATRIX.md`, `docs/JUDGE_QA.md`,
`docs/ROADMAP.md`, and `CHANGELOG.md`; the entries below are proposed for those files, not
applied here.

### CHANGELOG fragment

```
### Added
- User profile ("About you" in Settings): age band, chronic condition, outdoor worker, and
  pregnant status, captured locally and validated on read. Currently a no-op for risk
  assessment — see ADR-005; personalised thresholds are a future, separately reviewed
  milestone.
```

### BUILD_MATRIX row(s)

| Feature | Platform | Status | Device validated |
|---|---|---|---|
| User profile capture ("About you") | Android/iOS (React Native) | Unit/Integration tested (Jest) | NO |

### Proposed JUDGE_QA entries

**Q: Does the app know who I am, health-wise — age, conditions, whether I work outdoors?**
A: Settings has an "About you" section for age band, a long-term condition flag, outdoor-worker
status, and pregnancy. It is stored only on the device and is never sent anywhere, including in
an SOS alert. It does not yet change any risk warning — see the next question.

**Q: Does filling in "About you" make risk warnings more sensitive for me, e.g. as an elderly
or outdoor-working user?**
A: Not yet. That is a deliberate, documented decision (ADR-005): personalising a health-risk
threshold needs a methodology review before it ships, so this milestone only captures the
profile as an input for that review. A regression test proves the risk engine's output is
identical with or without a filled-in profile today.
