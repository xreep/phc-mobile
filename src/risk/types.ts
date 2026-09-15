/**
 * Types for the Tier-1 rule-based risk engine (PRD §7.2.2).
 *
 * The three imports below are this module's *only* coupling to the rest of the app,
 * they are all `import type` (erased at compile time), and their source file
 * (`src/constants/health-data.ts`) itself imports nothing. So the engine has zero
 * runtime dependencies: no React, no react-native, no Expo, no clock, no I/O.
 *
 * `src/constants/theme.ts` is off limits — it imports `react-native` and
 * `@/global.css`, and importing even a type from it would drag a value-level module
 * graph in and break framework-agnostic testing. The level→color mapping stays in
 * the UI, via `useRiskColors()`.
 */

import type {
  RiskCategory,
  RiskLevel,
  RiskTier,
  SensorSourceOption,
} from '@/constants/health-data';

/** Re-exported so engine modules have a single type source and never reach into
 *  `@/constants/health-data` themselves — which keeps the app-coupling surface to the
 *  one import above, where it is documented. */
export type { RiskCategory, RiskLevel, RiskTier };

/**
 * The four rule-engine categories (PRD §7.2.2). Derived from the UI's own type so
 * it can never drift. Not named `RiskCategory` — that identifier is already the
 * object type in health-data.ts.
 */
export type RiskCategoryKey = RiskCategory['key'];

/** Reused, not redefined, so the Settings sensor picker and the engine's provenance
 *  field cannot diverge. Add `'apple_health'` to `SensorSourceOption` when HealthKit
 *  lands, rather than widening here. */
export type SensorSource = SensorSourceOption['key'];

/**
 * Raw accelerometer sample, in **g with gravity included** — so magnitude ≈ 1.0 at
 * rest, matching `expo-sensors` `Accelerometer`. A source reporting m/s² (e.g.
 * `DeviceMotion`) must convert in its adapter, not here.
 */
export type MotionVector = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

/**
 * Pre-aggregated accelerometer statistics for the interval *ending* at the owning
 * reading's `timestamp`.
 *
 * This exists because of a sampling-rate mismatch that would otherwise make fall
 * detection impossible: PRD §7.2.1 polls Health Connect every 30–60 s, but a fall
 * impact lasts ~200 ms. A once-per-minute `MotionVector` will essentially never land
 * on the spike. The ingestion layer subscribes to the accelerometer at high rate and
 * folds peak/min/rms in here, which keeps the engine a pure function of the window.
 */
export type MotionSummary = {
  /** Largest magnitude seen in the interval, in g. */
  readonly peakG: number;
  /** Smallest magnitude seen in the interval, in g. */
  readonly minG: number;
  /** Root-mean-square magnitude over the interval, in g. */
  readonly rmsG: number;
  /** How many raw samples were folded in. 0 means "no motion data", not "still". */
  readonly sampleCount: number;
};

/**
 * PRD §7.2.1's unified sensor schema — the shape every adapter must produce
 * (`HealthConnectAdapter`, `HealthKitAdapter`, `BLEAdapter`).
 *
 * **camelCase, deliberately.** PRD §7.2.1 writes this schema in snake_case, but that
 * is prose describing a schema rather than a serialization contract, and it does not
 * even match the actual wire format: the ESP32 JSON in PRD §6.3 is
 * `{device_id, hr, spo2, temp, humidity, ts}` — different key names, an extra
 * `device_id` and `humidity`, and no `motion_vector` at all. A mapping layer is
 * therefore unavoidable regardless of naming, so the TS type follows the codebase's
 * existing camelCase-with-units convention (`VitalsSummary.skinTempC`,
 * `EnvironmentData.tempC`). Wire→domain mapping belongs in each adapter.
 *
 * **Every vital is optional on purpose.** Health Connect returns heart rate and SpO₂
 * as separate record types with independent timestamps, so a reading legitimately
 * carries one and not the other. Adapters MUST leave a missing signal `undefined`
 * and never substitute `0`: the engine reads `undefined` as "no signal" but would
 * read `spo2: 0` as catastrophic hypoxia and `hr: 0` as bradycardia, and could fire
 * a false emergency on it.
 */
export type SensorReading = {
  readonly source: SensorSource;
  /** Epoch milliseconds — not an ISO string; the window does arithmetic on it.
   *  Adapters parse PRD §6.3's `ts` / Health Connect instants into this. */
  readonly timestamp: number;
  /** Heart rate, bpm. */
  readonly hr?: number;
  /** Peripheral oxygen saturation, percent (0–100). */
  readonly spo2?: number;
  /** **Skin** temperature, °C. Not the ESP32's ambient DHT22 reading — that is
   *  environmental (see {@link EnvironmentSnapshot.tempC}); conflating them would
   *  silently break every heat rule. */
  readonly skinTempC?: number;
  readonly motion?: MotionVector;
  readonly motionSummary?: MotionSummary;
};

/**
 * Environment input (PRD §7.2.3). Deliberately narrower than the observation the app holds:
 * `@/environment`'s `toEnvironmentSnapshot` narrows a `LiveEnvironment` down to these
 * measurements and drops everything presentational, so no rule can key off a place name or a
 * band label this engine did not derive itself.
 */
export type EnvironmentSnapshot = {
  /** Ambient dry-bulb temperature, °C. */
  readonly tempC: number;
  /** Relative humidity, percent (0–100) — not a 0–1 fraction. */
  readonly humidity: number;
  /**
   * Trusted-upstream heat index override in °C. When absent the engine computes it from
   * `tempC`/`humidity`, which is what the OpenWeatherMap adapter relies on — the provider
   * publishes no NOAA heat index, and its `feels_like` is a *different* model, so passing
   * that here would put a figure the screen bands as NOAA next to one that is not.
   */
  readonly heatIndexC?: number;
  /** Air quality index. Unused by Tier 1; reserved for the respiratory multiplier. */
  readonly aqi?: number;
  /** Epoch ms the observation was made, for staleness checks. */
  readonly observedAt?: number;
};

/**
 * Stable rule identity — the discrete flag vector PRD §7.2.2's fusion logic weights
 * and PRD §7.2.5's SOS module switches on, so nothing downstream ever has to
 * string-match guidance prose.
 *
 * Read {@link SPEC_FLAG_RULES} and {@link CRITICAL_RULES} for which of these are
 * PRD-specified flags versus advisory precursors. That distinction is load-bearing:
 * only the former are the four flags PRD §7.2.2 mandates.
 */
export type RuleId =
  // ---- PRD §7.2.2 Tier-1 flags (the four specified rules) ----
  /** SpO₂ < 92 %. */
  | 'respiratory.spo2.low'
  /** HR > 120 bpm sustained at rest. */
  | 'cardiovascular.hr.tachycardia'
  /** HR < 40 bpm. */
  | 'cardiovascular.hr.bradycardia'
  /** Heat index in NOAA's Danger band. */
  | 'heat.index.danger'
  /** Heat index in NOAA's Extreme Danger band. */
  | 'heat.index.extremeDanger'
  /** Accelerometer spike followed by sustained stillness. */
  | 'fall.impactThenStillness'
  // ---- PRD §7.2.5 critical escalations ----
  /** SpO₂ < 85 %. */
  | 'respiratory.spo2.critical'
  /** Extreme heat index with no motion for > 10 min. */
  | 'heat.stillness.critical'
  // ---- Advisory precursors: NOT PRD §7.2.2 flags. Never set `flagged`. ----
  /** Heat index in NOAA's Extreme Caution band — below the Danger flag threshold. */
  | 'heat.index.extremeCaution'
  /** HR > 120 observed, but the sustained-at-rest condition is not confirmed. */
  | 'cardiovascular.hr.tachycardia.unconfirmed'
  /** Impact spike seen, but the following stillness is not confirmed. */
  | 'fall.impact.unconfirmed'
  /** Heat exposure with heart rate drifting above the window's own baseline. */
  | 'dehydration.cardiovascularDrift'
  /** The same drift, at a magnitude that reads as more than mild fluid loss. */
  | 'dehydration.cardiovascularDrift.severe'
  /** Prolonged stillness with an elevated resting heart rate. */
  | 'fatigue.inactiveElevatedHr';

/** The exact set of PRD §7.2.2 Tier-1 flags. Anything outside this set is advisory
 *  and must never be presented as one of the four specified flags. */
export const SPEC_FLAG_RULES: readonly RuleId[] = [
  'respiratory.spo2.low',
  'cardiovascular.hr.tachycardia',
  'cardiovascular.hr.bradycardia',
  'heat.index.danger',
  'heat.index.extremeDanger',
  'fall.impactThenStillness',
];

/** PRD §7.2.5 trigger set. The engine only *reports* these; the SOS module decides
 *  what to do, owns the 30 s cancel window, GPS, messaging, and the consent gate. */
export const CRITICAL_RULES: readonly RuleId[] = [
  'respiratory.spo2.critical',
  'fall.impactThenStillness',
  'heat.stillness.critical',
];

/**
 * How much to trust a category's level.
 *
 * Never widen `level` to the theme's fourth color `'neutral'` to express "no data":
 * `RiskCard`'s `LEVEL_LABEL: Record<RiskLevel, string>` has no entry for it and would
 * render `undefined`. Absence is reported here instead.
 */
export type DataQuality =
  /** Fresh, sufficient data for every rule in this category. */
  | 'ok'
  /** Some inputs present, some missing — level may understate the true risk. */
  | 'partial'
  /** Data exists but is older than the freshness bound. */
  | 'stale'
  /** No usable input at all. A green level here means "unknown", not "fine". */
  | 'missing';

/** Inclusive numeric bound, used for physiological plausibility gates. */
export type NumericRange = {
  readonly min: number;
  readonly max: number;
};

/** One field's value plus the instant it was observed. */
export type TimedValue = {
  readonly value: number;
  readonly timestamp: number;
};

/**
 * Per-category result.
 *
 * The intersection with `RiskCategory` is load-bearing: it makes every
 * `CategoryAssessment` directly assignable to `RiskCard`'s `category: RiskCategory`
 * prop, so `src/components/risk-card.tsx` needs no changes — and if anyone adds a
 * required field to `RiskCategory`, the engine stops compiling rather than silently
 * drifting from the UI contract.
 */
export type CategoryAssessment = RiskCategory & {
  /** Narrowed to required (it is optional on `RiskCategory`) so the card's third
   *  line never vanishes. With `dataQuality: 'missing'` it says so honestly. */
  readonly metric: string;
  /**
   * Narrowed to required for the same reason: the engine always knows which rung of the
   * category's ladder `guidance` came from, and `null` — nothing elevated — is one of the
   * answers rather than the absence of one. Derived from `score` through
   * `rules/recommend.ts`, never assigned beside it, so a `severe` tier cannot appear on an
   * amber card.
   */
  readonly tier: RiskTier | null;
  /** Steps for that rung, most urgent first. Empty exactly when `tier` is `null`. */
  readonly actions: readonly string[];
  /** `true` iff a PRD §7.2.2 Tier-1 flag fired. This is the spec-faithful output;
   *  `level` is presentation on top of it. */
  readonly flagged: boolean;
  /** Highest-severity rule that produced `level`; `null` when nothing fired. */
  readonly rule: RuleId | null;
  /** Every rule that fired, severity-descending. */
  readonly firedRules: readonly RuleId[];
  /** 0–100 rule-derived score, the same scale PRD §7.2.2 specifies for the ML
   *  output, so the fusion layer can combine them directly. */
  readonly score: number;
  /** PRD §7.2.2's environmental context multiplier — computed but deliberately
   *  **not** folded into `score`. The engine exposes it; fusion applies it. Folding
   *  it in here would double-apply it later. `1` means no adjustment. */
  readonly envMultiplier: number;
  /** A PRD §7.2.5 critical trigger fired. Reporting only — never acting. */
  readonly critical: boolean;
  /** Which critical triggers, so the SOS module never has to re-derive them from
   *  `firedRules` and can name the reason in the alert payload. */
  readonly criticalRules: readonly RuleId[];
  readonly dataQuality: DataQuality;
};

/** Complete Tier-1 assessment for one evaluation tick. */
export type RiskAssessment = {
  /** Worst level across all categories, for a global banner or notification. */
  readonly level: RiskLevel;
  /** Stable dashboard order: heat, respiratory, cardiovascular, fall — matching
   *  today's `RISK_CATEGORIES`, so this is a drop-in for `RISK_CATEGORIES.map(…)`. */
  readonly categories: readonly CategoryAssessment[];
  /** The same objects, keyed, for O(1) lookup by fusion / SOS / deep links. */
  readonly byCategory: Readonly<Record<RiskCategoryKey, CategoryAssessment>>;
  /** `null` when no environment snapshot was supplied. */
  readonly heatIndexC: number | null;
  /** `null` when no environment snapshot was supplied. */
  readonly heatIndexBand: { readonly label: string; readonly level: RiskLevel } | null;
  /** True when the heat index came from outside the regression's validated domain,
   *  so the number is not physically meaningful even though the band still warns. */
  readonly heatIndexOutOfDomain: boolean;
  /** Every PRD §7.2.2 flag that fired, across all categories. */
  readonly flaggedRules: readonly RuleId[];
  /** Every rule that fired, including advisory precursors. */
  readonly firedRules: readonly RuleId[];
  /** PRD §7.2.5 handoff: which critical triggers fired. */
  readonly criticalRules: readonly RuleId[];
  /** Convenience predicate — `criticalRules.length > 0`. The SOS module still owns
   *  debounce, the cancel window, consent, and delivery. */
  readonly sosCandidate: boolean;
  /** Echoed so the caller can assert its ring buffer is long enough. */
  readonly evaluatedAt: number;
  readonly windowMs: number;
  /** Readings that fell inside the window. */
  readonly sampleCount: number;
};

export type RiskAssessmentInput = {
  /**
   * Rolling window, oldest → newest. Readings older than the configured window
   * relative to `now` are ignored, so a longer buffer may be passed. The buffer must
   * span at least `max(window.ms, fall.stillnessWindowMs, stillness.heatCriticalMs +
   * window.maxGapMs, dehydration.windowMs, fatigue.windowMs)` — 18 minutes by default,
   * set by the fatigue rule's inactivity lookback. `assess.ts` computes that bound as
   * `longestLookbackMs`; `mock-sensor-window.test.ts` asserts the demo buffer clears it,
   * because a buffer shorter than the bound leaves the extended-lookback rules quietly
   * reading a truncated window rather than erroring.
   * Unsorted input is tolerated: the engine sorts defensively.
   */
  readonly readings: readonly SensorReading[];
  readonly environment?: EnvironmentSnapshot | null;
  /**
   * Evaluation instant, epoch ms. Defaults to the newest reading's timestamp.
   * Explicit so the engine never reads an ambient clock — same input, same output,
   * which is what makes these rules cheap to unit-test. Callers pass `Date.now()`.
   */
  readonly now?: number;
  readonly thresholds?: PartialRiskThresholds;
};

/** Every tunable constant, grouped. See `config.ts` for values and their sources. */
export type RiskThresholds = {
  readonly spo2: {
    /** PRD §7.2.2 flag: SpO₂ below this is a respiratory flag. */
    readonly flagBelow: number;
    /** PRD §7.2.5 critical escalation. */
    readonly criticalBelow: number;
    /**
     * Samples below `criticalBelow` required before reporting a *critical* — the flag
     * itself still fires on one reading, exactly as PRD §7.2.2 specifies.
     *
     * The asymmetry is the point. Optical PPG dropouts routinely emit values in the
     * 70–85 range that are physiologically plausible and so survive every range gate,
     * and a single one of those must not be able to place an emergency call. Requiring
     * confirmation costs one polling interval of latency on a real desaturation, while
     * leaving the mandated UI flag instantaneous.
     */
    readonly criticalMinSamples: number;
  };
  readonly heartRate: {
    /** PRD §7.2.2 flag: HR strictly above this, sustained at rest. */
    readonly tachycardiaAbove: number;
    /**
     * Hysteresis floor: once `tachycardiaAbove` has been exceeded, the episode is treated
     * as continuing while HR stays strictly above **this** value.
     *
     * **Must not exceed `tachycardiaAbove`** — `resolveRiskThresholds` clamps it down if
     * it does. A release value above the arm value would silently raise the effective
     * spec threshold, because a reading that arms the run would fail to hold it.
     *
     * Why it exists: without it a run breaks on any single reading at or below 120, and
     * consumer optical HR has a resting error around 7 bpm. A true HR of 125 therefore
     * produces readings straddling the threshold, and the run never accumulates. Worse,
     * one low reading *on the newest sample* used to collapse the run to `null` and take
     * the advisory down with it — five minutes of sustained tachycardia reported as a
     * green card. The spec threshold stays exactly 120; this only governs when an already
     * triggered episode is considered over.
     *
     * Too high (near 120): the noise problem returns. Too low: an episode latches on one
     * spike and then holds through genuinely normal readings — bounded by
     * `minSustainedSamples`, which counts only the readings that actually exceeded 120.
     */
    readonly tachycardiaReleaseAbove: number;
    /** PRD §7.2.2 flag: HR strictly below this. Not sustain-gated. */
    readonly bradycardiaBelow: number;
    /** How long the tachycardia condition must hold continuously. */
    readonly sustainedForMs: number;
    /**
     * Minimum readings *above `tachycardiaAbove`* inside that span before it can be
     * called "sustained". Counts armed readings only, not every reading in the span, so
     * hysteresis cannot turn one spike plus a long quiet stretch into a flag.
     */
    readonly minSustainedSamples: number;
    /** |magnitude − 1 g| at or below this counts as "at rest". */
    readonly restBandG: number;
    /**
     * Fraction of the sustained run's motion-bearing samples that must read
     * "at rest" for the tachycardia flag (rather than the advisory precursor).
     *
     * Per-sample rest is deliberately strict — it bounds the *peak*, because walking
     * keeps a central magnitude near 1 g (gravity dominates) while peaking well above
     * it, so a central-only test would call a walking user "at rest". Requiring only a
     * majority across the run then restores tolerance: shifting in a chair or reaching
     * for a glass no longer disqualifies genuine resting tachycardia, while sustained
     * exercise still fails the majority and is reported as advisory instead.
     */
    readonly minRestFraction: number;
  };
  readonly fall: {
    /** Impact spike magnitude, g (gravity included). */
    readonly impactG: number;
    /**
     * Ceiling on an interval's *minimum* magnitude for its spike to count as an impact.
     *
     * A fall is preceded by free-fall, so the interval containing it dips far below 1 g
     * before peaking. Walking does not: the peak is a footstrike, and there is no
     * near-weightless phase. Since `impactG` is compared against a peak taken over a
     * whole 30–60 s aggregation interval — a statistic in which ordinary pocket
     * footstrikes reach 2–2.5 g — the peak alone carries almost no information, and this
     * clause is what actually separates a fall from a walk.
     *
     * Only applied when a {@link MotionSummary} supplies `minG`. A lone raw vector has
     * no interval minimum to test, and rejecting those would disable fall detection
     * outright for that input shape rather than merely narrowing it.
     */
    readonly freeFallMaxG: number;
    /** |mean magnitude − 1 g| at or below this counts as still. Compared against the
     *  interval *mean*, not its peak, so a brief twitch does not break stillness —
     *  post-fall inactivity in the literature tolerates minor movement. */
    readonly restBandG: number;
    /**
     * Absolute ceiling on an interval's *peak* magnitude for it to count as still.
     *
     * Without this, mean-based stillness has a hole that matters: free-fall (≈0 g)
     * followed by impact (≫1 g) inside one aggregation interval averages back to
     * ≈1 g, so the very interval containing the fall would be classified "still".
     * Bounding the peak closes it while still tolerating small voluntary movement.
     */
    readonly stillnessPeakG: number;
    /** Stillness required after the impact to confirm a fall. */
    readonly stillnessMs: number;
    /**
     * How long after the impact to keep looking for that stillness.
     *
     * **Must be at least `stillnessMs + window.maxGapMs`.** This is the same
     * unsatisfiable-threshold trap as `window.ms` above, and it bites harder here.
     * Stillness is measured as the *span* between still readings, so a lone reading
     * inside the search window spans 0 ms and confirms nothing. At PRD §7.2.1's 30–60 s
     * poll cadence a 30 s window admits one reading at best and none at worst — the flag
     * then never fires, on any input, with nothing logged. `resolveRiskThresholds`
     * raises it rather than letting that happen.
     *
     * The consequence is that this value is set by the *data rate*, not by physiology:
     * it has to be wide enough for the sampler to land two readings in it. Attributing
     * stillness to an impact two minutes earlier is genuinely weaker evidence than
     * attributing it to one ten seconds earlier, which is why `freeFallMaxG` matters —
     * widening the window without gating the impact would turn "walked, then sat down"
     * into a confirmed fall.
     *
     * It has a second role: while the window is still open the fall verdict is reported
     * as *pending* rather than negative, because the answer can still change on the next
     * tick. Using `stillnessMs` for that grace period instead is a bug — it expires
     * before the first post-impact reading arrives — so the two must not be swapped.
     */
    readonly stillnessWindowMs: number;
  };
  readonly stillness: {
    /** PRD §7.2.5: "no motion for > 10 min" alongside an extreme heat index. */
    readonly heatCriticalMs: number;
  };
  /**
   * Dehydration advisory (PRD §7.2.4 extension). Heat exposure plus cardiovascular drift.
   *
   * Not a PRD §7.2.2 flag and not an SOS trigger — see {@link SPEC_FLAG_RULES}. The
   * physiology: plasma volume falls with fluid loss, so stroke volume falls, and heart rate
   * rises to hold cardiac output. Under heat load that shows up as a slow upward drift in
   * resting HR long before anything crosses PRD §7.2.2's 120 bpm bar, which is why this is
   * expressed as a rise *relative to the window's own baseline* rather than an absolute
   * number: an athlete resting at 52 and a patient resting at 88 both drift, and no single
   * absolute threshold catches both without drowning one of them in false positives.
   */
  readonly dehydration: {
    /**
     * Heat index (°F) at or above which exposure is considered a contributing load.
     *
     * NOAA's Extreme Caution floor. Deliberately *below* PRD §7.2.2's Danger flag: the
     * whole point of this advisory is to say something in the band where the mandated heat
     * flag is silent but sweat loss is already real.
     */
    readonly exposureMinF: number;
    /**
     * Lookback for the drift comparison.
     *
     * **Must leave room for both the baseline segment and a full sustained run** —
     * `windowMs × (1 − baselineFraction) ≥ sustainedForMs + window.maxGapMs`.
     * `resolveRiskThresholds` widens it if it does not, because otherwise the baseline
     * eats the window and the rule is unsatisfiable at every cadence, silently.
     */
    readonly windowMs: number;
    /**
     * Fraction of the window's samples, oldest first, that form the baseline.
     *
     * A fraction rather than a duration so the split is cadence-independent: 40 % of the
     * samples is 40 % of the span whatever the polling interval, whereas a fixed
     * `baselineMs` would silently contain zero samples at a coarse cadence. Clamped into
     * [0.1, 0.8] on resolve — at 1.0 the entire window is baseline and nothing can ever
     * fire, which is a division by zero in the reachability check as well as a bug.
     */
    readonly baselineFraction: number;
    /** Baseline samples required before a comparison is attempted at all. */
    readonly minBaselineSamples: number;
    /** Arm: HR strictly this far above the baseline mean. */
    readonly riseBpm: number;
    /**
     * Hold: an armed drift continues while HR stays this far above baseline.
     *
     * **Must not exceed `riseBpm`** — clamped down on resolve. Same Schmitt-trigger
     * rationale as `heartRate.tachycardiaReleaseAbove`, and the same empirical basis:
     * consumer optical HR carries roughly 7 bpm of resting error, so a true 10 bpm drift
     * produces readings that straddle the arm threshold.
     */
    readonly riseReleaseBpm: number;
    /** How long the drift must persist. */
    readonly sustainedForMs: number;
    /** Readings above the arm threshold required, independent of the span. */
    readonly minSustainedSamples: number;
    /**
     * Drift at or above this reads as more than mild fluid loss.
     *
     * **Must be at least `riseBpm`** — clamped up on resolve, since a severe threshold
     * below the arm threshold would make every drift severe.
     */
    readonly severeRiseBpm: number;
  };
  /**
   * Fatigue advisory (PRD §7.2.4 extension). Prolonged inactivity plus an elevated
   * resting heart rate.
   *
   * Not a PRD §7.2.2 flag and not an SOS trigger. Neither half means much alone — sitting
   * still is normal, and 92 bpm after climbing stairs is normal — but a heart rate that
   * stays elevated through twenty unbroken minutes of *not moving* is not explained by
   * exertion. The bar sits well below §7.2.2's 120 bpm on purpose: the conjunction with
   * stillness is what makes a smaller number meaningful, and it makes this rule a
   * complement to the tachycardia flag rather than a duplicate of it.
   */
  readonly fatigue: {
    /**
     * Lookback for both halves of the conjunction.
     *
     * **Must exceed `max(inactiveForMs, sustainedForMs)` by at least `window.maxGapMs`** —
     * `resolveRiskThresholds` widens it if it does not. The window is half-open, so a
     * window exactly as wide as the required span can only contain spans strictly shorter
     * than it; the extra gap also absorbs the newest reading's freshness lag, which at a
     * 60 s cadence is what decides whether the condition is reachable at all.
     */
    readonly windowMs: number;
    /** Trailing stillness required, measured with the fall rule's rest band and peak
     *  ceiling so "still" means one thing across the engine. */
    readonly inactiveForMs: number;
    /** Arm: resting HR strictly above this while inactive. */
    readonly restingHrAbove: number;
    /** Hold: **must not exceed `restingHrAbove`**, clamped down on resolve. */
    readonly restingHrReleaseAbove: number;
    /** How long the elevation must persist. */
    readonly sustainedForMs: number;
    /** Readings above the arm threshold required, independent of the span. */
    readonly minSustainedSamples: number;
  };
  /**
   * Personal baseline tracking (PRD §7.2.1 extension).
   *
   * Not a rule. Nothing here fires, scores, or escalates — this group sizes the *display*
   * comparison between the newest reading and the rolling average of the window it came from.
   * See `src/risk/baseline.ts` for why each vital is reported in a different unit.
   *
   * There is no `windowMs` in this group on purpose: the comparison spans exactly
   * `RiskAssessment.windowMs`, taken from the assessment itself, so the row and the cards
   * above it can never describe two different stretches of time.
   *
   * The three `minDelta*` values are **deadbands**, not thresholds. Their only job is to stop
   * the Dashboard reporting a difference smaller than the sensor can resolve, and each is in
   * its own vital's unit because a percentage is only meaningful for one of the three.
   */
  readonly baseline: {
    /**
     * Samples the average must be built from, *excluding* the newest reading.
     *
     * **Must not exceed `floor(window.ms / window.maxGapMs)`** — `resolveRiskThresholds`
     * clamps it. At the coarsest cadence the engine treats as continuous coverage a window
     * holds `floor(ms / maxGapMs) + 1` readings, and one of those is spent being the current
     * value. A larger floor is unreachable there, so the row would read "not enough readings
     * yet" forever — the cadence-versus-count trap, in the display layer this time.
     */
    readonly minBaselineSamples: number;
    /**
     * Smallest heart-rate difference worth reporting, bpm.
     *
     * Clamped on resolve into `[plausible.hr.max / 100, dehydration.riseBpm]`, floor first so it
     * wins a conflict. The floor is 1 % of the widest baseline the plausibility gate admits, and
     * below it a reportable difference rounds to "+0%" — a sentence with no content. The ceiling
     * keeps the deadband from being the reason the row is quieter than the rules beside it.
     */
    readonly minDeltaBpm: number;
    /**
     * Smallest SpO₂ difference worth reporting, in percentage **points** — never a percent.
     * Clamped up to 1 on resolve, the finest step the row prints.
     */
    readonly minDeltaSpo2Pct: number;
    /**
     * Smallest skin-temperature difference worth reporting, °C. Clamped up to 0.1 on resolve,
     * the finest step the row prints.
     */
    readonly minDeltaSkinTempC: number;
  };
  readonly window: {
    /**
     * Readings older than this (relative to `now`) are ignored.
     *
     * **Must exceed `heartRate.sustainedForMs`.** The window is half-open — `(now −
     * ms, now]` — so the widest span it can contain is strictly less than `ms`. Setting
     * the two equal makes the sustained-tachycardia condition mathematically
     * unsatisfiable, and it fails silently: the flag simply never fires.
     * `resolveRiskThresholds` checks this.
     */
    readonly ms: number;
    /** Below this many in-window readings, vitals categories report `partial`. */
    readonly minSamples: number;
    /** A newest reading older than this makes the assessment `stale`. */
    readonly maxStaleMs: number;
    /**
     * Largest gap between consecutive readings still treated as continuous coverage.
     *
     * Duration rules ask "did this condition hold *continuously* for N ms", and the
     * only evidence of continuity is that readings actually arrived. Without this
     * bound, two still readings ten minutes apart with nothing in between would count
     * as ten minutes of confirmed stillness, when in truth the interval is unobserved
     * — which is exactly how a sensor outage turns into a fabricated fall or a
     * fabricated heat-collapse alert.
     */
    readonly maxGapMs: number;
  };
  /**
   * Environmental amplification (PRD §7.2.3). These produce `envMultiplier` only —
   * the engine never folds them into `score`, because the fusion layer applies them
   * and doing it in both places would square the effect.
   */
  readonly env: {
    /** AQI at or below which no respiratory amplification applies. */
    readonly aqiNeutralBelow: number;
    /** AQI at or above which the maximum amplification applies. */
    readonly aqiSevereAbove: number;
    /** Respiratory multiplier reached at `aqiSevereAbove`. */
    readonly aqiMaxMultiplier: number;
    /** Cardiovascular amplification while the heat-stress flag is firing — heat
     *  raises cardiac demand, so the same heart rate means more strain. */
    readonly heatFlagMultiplier: number;
    /**
     * Weather-observation staleness bound, separate from `window.maxStaleMs`.
     *
     * Vitals and weather age at completely different rates: a heart rate three minutes
     * old is no longer current, while a weather observation half an hour old is
     * perfectly normal and is what providers actually serve. Sharing one bound would
     * force a choice between marking every heat assessment stale and letting genuinely
     * old vitals pass as fresh.
     */
    readonly maxStaleMs: number;
  };
  /**
   * Physiological plausibility gates. Values outside these are discarded as sensor
   * artifacts rather than believed.
   *
   * This is the engine's single most safety-sensitive policy, because both failure
   * directions are real: believing a bogus `spo2: 0` fires a false emergency, while
   * discarding a true reading suppresses a real one. The ranges are therefore set
   * *wide* — wide enough to admit every value a living person can produce, narrow
   * enough to reject values that are physically impossible for one. Rejections are
   * surfaced through `dataQuality`, never silently swallowed.
   */
  readonly plausible: {
    readonly hr: NumericRange;
    readonly spo2: NumericRange;
    readonly skinTempC: NumericRange;
    /** Accelerometer magnitude in g. Bounds a phone's sensor saturation range. */
    readonly motionG: NumericRange;
  };
};

/** Per-group partial, so a test can override one number without restating the tree. */
export type PartialRiskThresholds = {
  readonly [K in keyof RiskThresholds]?: Partial<RiskThresholds[K]>;
};
