/**
 * User profile (PS §3d — high-risk notifications for vulnerable individuals).
 *
 * ## What this is not
 * These fields are **captured, not applied**. `vulnerabilityFactors` and `isVulnerable` are
 * pure classification: they say which factors are present, and nothing else in the app reads
 * their output yet. `src/risk/` is untouched by this module — see
 * `docs/decisions/ADR-005-personalisation-inputs-before-thresholds.md` for why: adjusting a
 * health-risk threshold for age, a chronic condition, outdoor exposure, or pregnancy is a
 * methodology decision that needs a documented review, not something a settings screen should
 * do as a side effect of adding a toggle. This module exists so that review has real inputs to
 * work from when it happens, and `src/__tests__/home-screen.test.tsx`'s
 * "profile is a no-op for the risk engine" suite is the regression test that keeps it that way
 * until a human explicitly wires it in.
 *
 * ## Validate on read, same as the rest of the store
 * `parseProfile` follows `src/settings/store.ts`'s pattern exactly: a stored blob was written
 * by a *previous build*, so every field is checked and anything unreadable falls back to
 * {@link DEFAULT_PROFILE} rather than being partially trusted. There is no separate failure
 * mode to design for here — a malformed profile degrading to "nothing is known about this
 * user" is always a safe default, unlike a malformed contact list.
 */

/** `'unknown'` is the default — a profile the user has not filled in must not silently read
 *  as "not vulnerable due to age" the way `'18to39'` would. */
export type AgeBand = 'unknown' | 'under18' | '18to39' | '40to59' | '60plus';

export type UserProfile = {
  readonly ageBand: AgeBand;
  readonly chronicCondition: boolean;
  readonly outdoorWorker: boolean;
  readonly pregnant: boolean;
};

/** Least-assuming state: nothing is known, so nothing is flagged. */
export const DEFAULT_PROFILE: UserProfile = Object.freeze({
  ageBand: 'unknown',
  chronicCondition: false,
  outdoorWorker: false,
  pregnant: false,
});

/** One row per {@link AgeBand}, in the order the Settings picker shows them. Kept beside the
 *  type rather than in `@/constants/health-data` so this module stays self-contained and the
 *  picker's labels cannot drift out of sync with the values `parseProfile` accepts. */
export type AgeBandOption = {
  readonly key: AgeBand;
  readonly label: string;
};

export const AGE_BANDS: readonly AgeBandOption[] = [
  { key: 'unknown', label: 'Prefer not to say' },
  { key: 'under18', label: 'Under 18' },
  { key: '18to39', label: '18–39' },
  { key: '40to59', label: '40–59' },
  { key: '60plus', label: '60 and over' },
];

const AGE_BAND_KEYS = new Set<string>(AGE_BANDS.map((band) => band.key));

/**
 * Accept a stored profile field by field. Anything malformed reverts that one field to its
 * default rather than discarding the whole profile — a `chronicCondition` written as `"yes"`
 * by a hypothetical future build should not also lose a perfectly valid `ageBand`.
 */
export function parseProfile(value: unknown): UserProfile {
  if (typeof value !== 'object' || value === null) return DEFAULT_PROFILE;
  const record = value as Record<string, unknown>;

  const ageBand =
    typeof record.ageBand === 'string' && AGE_BAND_KEYS.has(record.ageBand)
      ? (record.ageBand as AgeBand)
      : DEFAULT_PROFILE.ageBand;

  return {
    ageBand,
    chronicCondition: record.chronicCondition === true,
    outdoorWorker: record.outdoorWorker === true,
    pregnant: record.pregnant === true,
  };
}

/**
 * Ids for the individual signals a profile carries. Reserved for the personalisation
 * milestone (see the module header) — currently used only to render "About you" state back to
 * the user, never to alter risk output.
 */
export type VulnerabilityFactor =
  | 'age60plus'
  | 'under18'
  | 'chronicCondition'
  | 'outdoorWorker'
  | 'pregnant';

/**
 * Which factors apply, in a fixed order so callers get a stable list rather than depending on
 * object key order. Age contributes at most one factor — a profile cannot be simultaneously
 * `under18` and `60plus`, since {@link AgeBand} is a single choice.
 */
export function vulnerabilityFactors(profile: UserProfile): readonly VulnerabilityFactor[] {
  const factors: VulnerabilityFactor[] = [];
  if (profile.ageBand === '60plus') factors.push('age60plus');
  if (profile.ageBand === 'under18') factors.push('under18');
  if (profile.chronicCondition) factors.push('chronicCondition');
  if (profile.outdoorWorker) factors.push('outdoorWorker');
  if (profile.pregnant) factors.push('pregnant');
  return factors;
}

/** Whether any factor applies at all. Thin wrapper, but it reads better at call sites than
 *  `vulnerabilityFactors(profile).length > 0` repeated everywhere. */
export function isVulnerable(profile: UserProfile): boolean {
  return vulnerabilityFactors(profile).length > 0;
}
