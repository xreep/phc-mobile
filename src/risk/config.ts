/**
 * Tier-1 threshold configuration (PRD §7.2.2).
 *
 * Every number the engine uses lives here, in one place, so the values are auditable
 * without reading the rules and so a clinician reviewing them never has to grep.
 *
 * ## Two kinds of number, and why the distinction matters
 *
 * **Specified.** `92`, `120`, `40`, and the NOAA band floors come straight from
 * PRD §7.2.2 and are not tuning knobs. Changing one changes what the product claims to
 * do, so each is marked *SPEC* below and the unit tests assert them as literals — a
 * config edit that drifts from the spec fails the suite rather than shipping quietly.
 *
 * **Derived.** Everything else — how long "sustained" is, what "at rest" means, the
 * impact and stillness parameters — the spec leaves open, and no amount of reading it
 * will produce them. Each is marked *DERIVED* with the reasoning and the failure mode in
 * both directions.
 *
 * ## The tuning bias, stated once
 * This is a consumer wellness aid, not a regulated medical device. A false alarm is an
 * annoyance the user dismisses; a missed event is the harm the product exists to
 * prevent. So where the evidence is ambiguous, the derived values lean **sensitive**.
 * The two things that make that lean affordable are that no rule here acts on its own —
 * PRD §7.2.5 puts a 30-second user cancel in front of any emergency call — and that
 * `dataQuality` reports when a level rests on thin evidence.
 */

import type { PartialRiskThresholds, RiskThresholds } from './types';

/** This module is the always-on rule layer. The TFLite model is Tier 2, a later phase. */
export const RISK_ENGINE_TIER = 1 as const;

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
  spo2: {
    /** SPEC (PRD §7.2.2): SpO₂ < 92 %. Strict `<` — 92.0 does not flag. */
    flagBelow: 92,
    /** SPEC (PRD §7.2.5): the critical escalation threshold. */
    criticalBelow: 85,
    /**
     * DERIVED: 2. One reading flags (as specified); two are needed to call an
     * emergency. Too high delays a real desaturation by a polling interval per extra
     * sample; too low (1) lets a single PPG dropout — which readily produces plausible
     * values in the 70s — place an emergency call.
     */
    criticalMinSamples: 2,
  },

  heartRate: {
    /** SPEC (PRD §7.2.2): HR > 120 bpm. Strict `>` — 120 does not flag. */
    tachycardiaAbove: 120,
    /**
     * DERIVED: 110 bpm — an 8 % deadband below the arm threshold. Strict `>`, so 110
     * itself ends the episode.
     *
     * This is a hysteresis floor, not a second detection threshold: nothing fires at 110.
     * It only decides when an episode that already crossed 120 is considered over.
     *
     * The size comes from the sensor, not from physiology. Wrist optical HR carries a
     * resting mean absolute error near 7 bpm, so a true 125 emits readings straddling 120
     * and a strictly-consecutive run never accumulates — a measured sequence of
     * `129, 131, 118, 127, 133, 122, 119, 128` is eight minutes of real tachycardia whose
     * longest strict run is a single sample. Ten bpm covers roughly 1.4 × that error.
     *
     * Too high: the straddling problem returns. Too low: a single spike latches an
     * episode that then holds through normal readings — which is why
     * `minSustainedSamples` counts only readings above 120.
     */
    tachycardiaReleaseAbove: 110,
    /** SPEC (PRD §7.2.2): HR < 40 bpm. Strict `<` — 40 does not flag. */
    bradycardiaBelow: 40,
    /**
     * DERIVED: 5 minutes.
     *
     * The nearest documented prior art is Apple Watch's high-heart-rate notification,
     * which requires roughly 10 minutes above threshold while the wearer appears
     * inactive. Half that is used here because this engine feeds a *risk dashboard*
     * rather than a standalone notification, its tachycardia rule is explicitly not an
     * emergency trigger, and heat-driven cardiac strain — the primary use case — is
     * worth surfacing before it has persisted for ten minutes.
     *
     * Too high: transient-but-real strain resolves before it is ever shown. Too low:
     * ordinary exertion recovery (climbing stairs, hurrying for a bus) reads as
     * pathological, and the card loses credibility.
     */
    sustainedForMs: 5 * MINUTE,
    /**
     * DERIVED: 3. Duration alone is not enough — at a 30–60 s poll a span can be
     * spanned by very few points, and two artifacts several minutes apart would
     * otherwise satisfy it. Three independent readings cannot be one dropout.
     */
    minSustainedSamples: 3,
    /**
     * DERIVED: 0.2 g of *peak* deviation from 1 g.
     *
     * Sitting still in a pocket holds peak deviation well under 0.1 g; deliberate
     * movement (gesturing, reaching) reaches 0.1–0.3 g; walking peaks far above.
     * 0.2 g therefore separates rest from ambulation while tolerating fidgeting.
     * Too high: a walking user counts as resting and exercise tachycardia is reported
     * as pathological. Too low: a resting user who shifts position is called active and
     * a genuine flag is downgraded to advisory.
     */
    restBandG: 0.2,
    /**
     * DERIVED: 0.5 — a simple majority of the run's motion-bearing samples.
     *
     * Paired with the strict per-sample test above, this is what tolerates real life:
     * someone resting with a fast heart rate who twice reaches for a glass still
     * flags, while someone exercising throughout does not. Too high (1.0) means one
     * movement in five minutes suppresses the flag; too low means light activity
     * passes as rest.
     */
    minRestFraction: 0.5,
  },

  fall: {
    /**
     * DERIVED: 2.5 g peak, gravity included.
     *
     * Threshold-based fall detection in the literature clusters around 2–3 g at the
     * trunk. A pocket-carried phone is a worse sensor than a waist-mounted research
     * unit — coupling is loose and the impact partly absorbed by clothing and body —
     * which argues for the sensitive end of that range rather than the middle.
     *
     * Too high: real falls, especially onto soft surfaces or from a seated height,
     * never register. Too low: sitting down heavily, setting the phone on a table, or a
     * pocket knock all register, and the follow-on stillness test is then the only
     * thing preventing a false alert.
     */
    impactG: 2.5,
    /**
     * DERIVED: 0.65 g interval minimum. Kangas' pre-impact criterion is < 0.75 g; 0.65
     * leaves margin below that while staying well under the ≈0.7 g dip an ordinary
     * pocket-carried walking stride produces.
     *
     * This clause, not `impactG`, is what discriminates. Because both are read from a
     * summary over a 30–60 s interval, `peakG` is a maximum over ~1500–3000 raw samples
     * and ordinary footstrikes reach 2–2.5 g in it — the same band as a fall. Free-fall
     * has no everyday analogue, so the minimum is the informative half.
     *
     * Known weakness, and the reason this is a stopgap: a minimum over a *whole minute*
     * of walking will eventually dip low on some swing phase, so the gate erodes as the
     * aggregation interval grows. The real fix is per-sample impact detection in the
     * ingestion layer (PRD §7.2.1) emitting an explicit impact peak and timestamp, at
     * which point this rule should consume that instead of re-deriving it from a summary.
     */
    freeFallMaxG: 0.65,
    /**
     * DERIVED: 0.15 g of deviation in the interval's *central* (RMS) magnitude.
     *
     * This is a **plausibility guard, not the movement test.** For any signal
     * oscillating about 1 g, RMS ≈ 1 + s²/2, so escaping a 0.15 g band needs a standard
     * deviation near 0.55 g — and `stillnessPeakG` rejects a peak that large first. On
     * ordinary human motion the band therefore never decides the outcome: walking has
     * RMS ≈ 1.05, comfortably inside it. `stillnessPeakG` is what keeps walking out.
     *
     * What it does catch is a magnitude that is steady but *not gravity*: a minute
     * averaging 1.2 g (sustained acceleration) or 0.5 g (a stuck or miscalibrated
     * accelerometer) passes the peak ceiling and must not be read as "lying still".
     * `src/risk/__tests__/stillness.test.ts` pins both roles, including the case where
     * the band provably cannot bind, so it is not credited with work it does not do.
     */
    restBandG: 0.15,
    /**
     * DERIVED: 1.4 g absolute peak ceiling. Rejects any interval containing a real
     * impact — which is what stops free-fall-then-impact from averaging out to
     * "still" — while leaving headroom for the small movements of someone who is down
     * and hurt.
     */
    stillnessPeakG: 1.4,
    /**
     * DERIVED: 10 seconds. Post-fall inactivity periods in the literature run from
     * about 2 s upward; 10 s is long enough that sitting down heavily and then pausing
     * does not qualify, short enough to alert while it still matters.
     *
     * **Quantized by the poll rate, and not literally 10 s.** Stillness is the *span*
     * between still readings, so the smallest observable value is one poll interval.
     * At PRD §7.2.1's 30–60 s cadence every setting in (0, 30 s] behaves identically —
     * "two consecutive still polls" — so this reads as 30–60 s in practice. It becomes
     * literal only once stillness is evaluated per-sample in the ingestion layer.
     *
     * Kept at 10 s rather than raised to a nominal 60 s because the effective value is
     * already the poll interval; writing 60 s would encode the current cadence into the
     * threshold and then *over*-shoot if ingestion ever samples faster. The floor that
     * has to move with the cadence is `stillnessWindowMs`, which `resolveRiskThresholds`
     * derives from this plus `window.maxGapMs`.
     */
    stillnessMs: 10 * SECOND,
    /**
     * DERIVED: `stillnessMs + maxGapMs` = 2 min 10 s of search after the impact.
     *
     * This number is dictated by the sampling rate, not by physiology. Stillness is
     * measured as the *span* between still readings, so the window has to be wide enough
     * for the sampler to place two readings inside it. PRD §7.2.1 polls every 30–60 s,
     * and the previous value here was 30 s — which meant one reading landed in the window
     * at best and none at worst, a span of 0 ms, and the fall flag could not fire at all.
     * That failed silently: every test in the suite sampled at 1 Hz, so it passed.
     *
     * Too low is therefore not "less sensitive", it is "off". Too high weakens the
     * attribution — stillness two minutes after a spike is thinner evidence that the
     * spike caused it — which is carried by `freeFallMaxG` gating the spike instead.
     *
     * `resolveRiskThresholds` enforces the floor, so an override cannot reintroduce this.
     */
    stillnessWindowMs: 10 * SECOND + 2 * MINUTE,
  },

  stillness: {
    /** SPEC (PRD §7.2.5): "no motion for > 10 min" alongside an extreme heat index. */
    heatCriticalMs: 10 * MINUTE,
  },

  dehydration: {
    /**
     * SPEC-adjacent: 90 °F is NOAA's Extreme Caution floor, the same table PRD §7.2.2's
     * heat flag is drawn from. Chosen as the *lowest* published band that implies real
     * sweat loss, because the point of this advisory is the range where the mandated heat
     * flag (103 °F) is still silent.
     */
    exposureMinF: 90,
    /**
     * DERIVED: 15 minutes. Cardiovascular drift under heat load develops over roughly
     * 10–30 minutes, so a window shorter than this cannot distinguish drift from the
     * ordinary minute-to-minute variation in resting HR.
     *
     * The floor `resolveRiskThresholds` enforces is
     * `(sustainedForMs + maxGapMs) / (1 − baselineFraction)` = 7 min / 0.6 ≈ 11 min 40 s,
     * so 15 minutes carries real slack rather than sitting on the boundary.
     */
    windowMs: 15 * MINUTE,
    /**
     * DERIVED: 0.4. The oldest 40 % of the window's samples establish the baseline; the
     * newest 60 % is where a drift run may be found.
     *
     * Too high starves the run — at 0.8 the remaining 20 % of a 15-minute window is
     * 3 minutes, shorter than `sustainedForMs`, and the rule cannot fire. Too low makes
     * the baseline itself noisy, and since a noisy baseline can be low as easily as high,
     * that direction produces false positives rather than misses.
     *
     * Known and accepted bias: if HR has been climbing across the *whole* window, the
     * baseline segment contains part of the climb, so the measured rise understates the
     * true one. That errs toward silence on the slowest drifts, which is the safe
     * direction for an advisory that must not cry wolf.
     */
    baselineFraction: 0.4,
    /** DERIVED: 3 — the same floor `window.minSamples` uses for "not guessing". Below
     *  this the baseline mean is one or two points and a single artifact moves it. */
    minBaselineSamples: 3,
    /**
     * DERIVED: 10 bpm above baseline. Sports-medicine practice treats a resting HR
     * elevation of roughly 5–10 bpm as a marker of dehydration or incomplete recovery;
     * this takes the top of that range because consumer optical HR carries about 7 bpm of
     * resting error, and a threshold inside the noise floor is not a threshold.
     */
    riseBpm: 10,
    /** DERIVED: 4 bpm — a 6 bpm deadband, sized like `tachycardiaReleaseAbove` for the
     *  same reason: a real 10 bpm drift emits readings straddling the arm threshold. */
    riseReleaseBpm: 4,
    /**
     * DERIVED: 5 minutes, matching `heartRate.sustainedForMs`. Long enough that a flight
     * of stairs inside an otherwise still window cannot produce it, short enough to be
     * observable several times over inside `windowMs`.
     */
    sustainedForMs: 5 * MINUTE,
    /** DERIVED: 3 readings above the arm threshold. At PRD §7.2.1's 30–60 s cadence a
     *  5-minute span holds 6–11 readings, so this is reachable with margin. */
    minSustainedSamples: 3,
    /** DERIVED: 20 bpm — twice the arm threshold, and roughly the elevation associated
     *  with fluid loss past about 3 % of body mass. */
    severeRiseBpm: 20,
  },

  fatigue: {
    /**
     * DERIVED: 18 minutes = `inactiveForMs` + 3 minutes.
     *
     * The enforced floor is `inactiveForMs + maxGapMs` = 17 minutes, and the extra minute
     * is not decoration. At a 60 s cadence with a 60 s freshness lag, a 17-minute
     * half-open window admits readings at `now − 60 s − k × 60 s` for k ≤ 15, a span of
     * exactly 15 minutes — the condition is satisfiable only by equality, and any extra
     * lag makes it unsatisfiable. Eighteen minutes buys a full sample of slack. This is
     * the fourth appearance of that trap in this file; `fatigue.test.ts` asserts the
     * reachability directly at each cadence rather than trusting the arithmetic here.
     */
    windowMs: 18 * MINUTE,
    /**
     * DERIVED: 15 minutes of unbroken stillness. Longer than `stillness.heatCriticalMs`
     * (10 min) on purpose: that one is a PRD-specified emergency precursor paired with
     * extreme heat, whereas this is an advisory paired only with heart rate, so it needs
     * to be past the length of an ordinary sit-down to mean anything.
     *
     * Too low turns every desk hour amber. Too high pushes the window past the buffer the
     * app actually keeps — `mock-sensor-window.test.ts` asserts the buffer clears
     * `longestLookbackMs`, which this value sets.
     */
    inactiveForMs: 15 * MINUTE,
    /**
     * DERIVED: 90 bpm. Above the 60–80 bpm resting range for adults and above the
     * ~85 bpm upper bound of "normal resting" in most references, but far below
     * PRD §7.2.2's 120 bpm flag — a number that is only meaningful *because* it is
     * conjoined with fifteen minutes of not moving.
     *
     * Too low: normal resting variation, and every user sitting quietly is fatigued. Too
     * high: it collides with the tachycardia flag and stops being a distinct signal.
     */
    restingHrAbove: 90,
    /** DERIVED: 82 bpm — an 8 bpm deadband, one sensor-error width, same as the
     *  cardiovascular rule's. */
    restingHrReleaseAbove: 82,
    /**
     * DERIVED: 12 minutes. Shorter than `inactiveForMs` so the stillness requirement is
     * the binding constraint: a heart rate that rose partway through a long still stretch
     * still qualifies, which is the shape genuine fatigue actually has.
     */
    sustainedForMs: 12 * MINUTE,
    /**
     * DERIVED: 5 readings. Must stay under `sustainedForMs / maxGapMs + 1` = 7 or the
     * count becomes unsatisfiable at the widest gap the engine tolerates — the same
     * cadence-versus-count trap as the duration thresholds, asserted in `fatigue.test.ts`.
     */
    minSustainedSamples: 5,
  },

  window: {
    /**
     * DERIVED: 10 minutes. Must exceed `heartRate.sustainedForMs` (see the type doc —
     * equal values make the tachycardia flag unsatisfiable), and doubling it leaves
     * room for the run to be observed rather than only just fitting.
     */
    ms: 10 * MINUTE,
    /** DERIVED: 3 — below this a category reports `partial` rather than claiming a
     *  confident level from one or two points. */
    minSamples: 3,
    /**
     * DERIVED: 3 minutes for *vitals*. PRD §7.2.1 polls every 30–60 s, so three
     * minutes is several missed cycles — enough to be a real gap, not jitter.
     */
    maxStaleMs: 3 * MINUTE,
    /**
     * DERIVED: 2 minutes — twice the slowest expected poll. A gap wider than this is a
     * coverage hole, and unobserved time must not count toward a duration rule.
     */
    maxGapMs: 2 * MINUTE,
  },

  env: {
    /** DERIVED: AQI ≤ 100 applies no amplification. 100 is the top of "satisfactory"
     *  on the Indian CPCB scale and of "moderate" on the US EPA scale. */
    aqiNeutralBelow: 100,
    /** DERIVED: AQI ≥ 300 is "very poor" (CPCB) / "hazardous" (EPA) — full effect. */
    aqiSevereAbove: 300,
    /** DERIVED: 1.3. Deliberately modest: this reports context, and Tier 1 must not
     *  let air quality alone manufacture a respiratory flag. */
    aqiMaxMultiplier: 1.3,
    /** DERIVED: 1.2. Heat raises cardiac demand, so the same heart rate represents
     *  more strain (PRD §7.2.3). Reported for fusion, never folded into `score`. */
    heatFlagMultiplier: 1.2,
    /** DERIVED: 1 hour. Weather observations are legitimately tens of minutes old;
     *  see the type doc on why this is not shared with `window.maxStaleMs`. */
    maxStaleMs: 60 * MINUTE,
  },

  plausible: {
    /**
     * Wide on purpose. The gate exists to reject the physically impossible, not to
     * second-guess the alarming: every bound below still admits values that fire flags,
     * because a gate that rejected them would be a silent way of disabling the engine.
     */
    hr: { min: 20, max: 300 },
    /**
     * Floor of 50 %, not the 70 % consumer oximeters are typically specified to.
     * Readings below 70 % are usually artifacts — but "usually" is not good enough
     * when the alternative is discarding a genuine crisis, and the critical path
     * requires confirmation anyway.
     */
    spo2: { min: 50, max: 100 },
    /** Skin, not core — normal skin temperature runs well below core (roughly
     *  33–35 °C), and this range brackets survivable extremes on either side. */
    skinTempC: { min: 20, max: 45 },
    /** Magnitude in g. Phone accelerometers commonly saturate at ±8 g or ±16 g per
     *  axis, so a full-scale three-axis magnitude can reach ≈28 g. */
    motionG: { min: 0, max: 32 },
  },
};

/** Copy only the keys actually present, so an explicit `undefined` in a caller's
 *  override cannot blank a default out. */
function mergeGroup<T extends object>(base: T, override: Partial<T> | undefined): T {
  if (override === undefined) return base;
  const merged = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const value = override[key];
    if (value !== undefined) merged[key] = value as T[keyof T];
  }
  return merged;
}

/**
 * Merge caller overrides onto the defaults, group by group, then normalize.
 *
 * ## Why this repairs rather than throws
 * `assessRisk` runs on every sensor tick, and a config error that threw would take the
 * app down mid-monitoring — the worst possible response from a safety component. So an
 * unsatisfiable window is widened instead, which fails toward the flag remaining able
 * to fire. The alternative, leaving it alone, is the one genuinely unacceptable option:
 * the tachycardia rule would silently never fire, and nothing anywhere would say so.
 */
export function resolveRiskThresholds(overrides?: PartialRiskThresholds): RiskThresholds {
  const base = DEFAULT_RISK_THRESHOLDS;
  if (overrides === undefined) return base;

  const heartRate = mergeGroup(base.heartRate, overrides.heartRate);
  const window = mergeGroup(base.window, overrides.window);
  const fall = mergeGroup(base.fall, overrides.fall);

  // The window is half-open, `(now − ms, now]`, so the widest span it can hold is
  // strictly less than `ms`. One extra `maxGapMs` of headroom guarantees the sustained
  // run is observable rather than exactly borderline.
  const minimumWindowMs = heartRate.sustainedForMs + window.maxGapMs;

  // Same trap, applied to the post-impact search. Stillness is a *span* between
  // readings, so a window narrower than one poll interval can only ever contain a
  // single reading spanning 0 ms, and the fall flag becomes unsatisfiable rather than
  // merely strict. `maxGapMs` is the engine's bound on how far apart readings may be,
  // so it is the right allowance for "wide enough to hold two of them".
  const minimumStillnessWindowMs = fall.stillnessMs + window.maxGapMs;

  // Third instance of it, in a different disguise. A release threshold above the arm
  // threshold means a reading that arms the run cannot hold it, so the trailing run
  // needs a value above the *release* level — silently moving the spec's 120 upward.
  // Clamping to equality degrades to the strict, no-hysteresis behaviour, which is
  // merely less noise-tolerant rather than broken.
  const tachycardiaReleaseAbove = Math.min(
    heartRate.tachycardiaReleaseAbove,
    heartRate.tachycardiaAbove,
  );

  return {
    spo2: mergeGroup(base.spo2, overrides.spo2),
    heartRate:
      tachycardiaReleaseAbove === heartRate.tachycardiaReleaseAbove
        ? heartRate
        : { ...heartRate, tachycardiaReleaseAbove },
    fall:
      fall.stillnessWindowMs >= minimumStillnessWindowMs
        ? fall
        : { ...fall, stillnessWindowMs: minimumStillnessWindowMs },
    stillness: mergeGroup(base.stillness, overrides.stillness),
    dehydration: repairDehydration(mergeGroup(base.dehydration, overrides.dehydration), window),
    fatigue: repairFatigue(mergeGroup(base.fatigue, overrides.fatigue), window),
    window:
      window.ms >= minimumWindowMs ? window : { ...window, ms: minimumWindowMs },
    env: mergeGroup(base.env, overrides.env),
    plausible: mergeGroup(base.plausible, overrides.plausible),
  };
}

/**
 * Widest usable baseline share. Above this the newest slice of the window is too small to
 * hold a sustained run at any cadence; at 1.0 the reachability check below divides by zero.
 */
const MAX_BASELINE_FRACTION = 0.8;
/** Narrowest useful baseline share — below it the baseline mean is a single artifact away
 *  from moving the whole comparison. */
const MIN_BASELINE_FRACTION = 0.1;

/**
 * Fourth and fifth instances of the unsatisfiable-threshold trap, in the dehydration rule.
 *
 * Two of them here are the same shape as `tachycardiaReleaseAbove` — a release threshold
 * above its arm threshold, or a "severe" threshold below the mild one, both of which make a
 * tier unreachable or universal without any error. The third is the window: the baseline
 * consumes the oldest `baselineFraction` of it, so the run has only the remainder to live
 * in, and if that remainder is shorter than `sustainedForMs` the rule cannot fire at any
 * cadence. Widening the window is the repair that fails toward the rule still working.
 */
function repairDehydration(
  group: RiskThresholds['dehydration'],
  window: RiskThresholds['window'],
): RiskThresholds['dehydration'] {
  const baselineFraction = Math.min(
    Math.max(group.baselineFraction, MIN_BASELINE_FRACTION),
    MAX_BASELINE_FRACTION,
  );
  const riseReleaseBpm = Math.min(group.riseReleaseBpm, group.riseBpm);
  const severeRiseBpm = Math.max(group.severeRiseBpm, group.riseBpm);

  // The run lives in the newest `1 − baselineFraction` of the window, and needs
  // `sustainedForMs` of span plus one `maxGapMs` of headroom for the half-open boundary and
  // the newest reading's freshness lag. `ceil` so integer milliseconds never round the
  // window back under its own floor.
  const minimumWindowMs = Math.ceil(
    (group.sustainedForMs + window.maxGapMs) / (1 - baselineFraction),
  );

  return {
    ...group,
    baselineFraction,
    riseReleaseBpm,
    severeRiseBpm,
    windowMs: Math.max(group.windowMs, minimumWindowMs),
  };
}

/** Same two traps once more: a release threshold above its arm threshold, and a window too
 *  narrow to contain the span it demands. */
function repairFatigue(
  group: RiskThresholds['fatigue'],
  window: RiskThresholds['window'],
): RiskThresholds['fatigue'] {
  const minimumWindowMs =
    Math.max(group.inactiveForMs, group.sustainedForMs) + window.maxGapMs;

  return {
    ...group,
    restingHrReleaseAbove: Math.min(group.restingHrReleaseAbove, group.restingHrAbove),
    windowMs: Math.max(group.windowMs, minimumWindowMs),
  };
}
