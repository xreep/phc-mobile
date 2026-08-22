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
     * DERIVED: 0.15 g of deviation in the interval's *central* magnitude. Slightly
     * tighter than the cardiac rest band because this one gates an emergency path, and
     * unlike that band it is not a peak test — brief movement is meant to survive it.
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
     * Too high: help is delayed, and a user who briefly stirs resets the clock. Too
     * low: every deliberate "put the phone down and leave it" becomes a possible fall.
     */
    stillnessMs: 10 * SECOND,
    /**
     * DERIVED: 30 seconds of search after the impact. People who fall commonly move
     * for several seconds — rolling, trying to get up — before going still, so
     * requiring stillness to begin immediately misses real falls. Too long, and
     * unrelated stillness half a minute later gets attributed to the impact.
     */
    stillnessWindowMs: 30 * SECOND,
  },

  stillness: {
    /** SPEC (PRD §7.2.5): "no motion for > 10 min" alongside an extreme heat index. */
    heatCriticalMs: 10 * MINUTE,
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

  // The window is half-open, `(now − ms, now]`, so the widest span it can hold is
  // strictly less than `ms`. One extra `maxGapMs` of headroom guarantees the sustained
  // run is observable rather than exactly borderline.
  const minimumWindowMs = heartRate.sustainedForMs + window.maxGapMs;

  return {
    spo2: mergeGroup(base.spo2, overrides.spo2),
    heartRate,
    fall: mergeGroup(base.fall, overrides.fall),
    stillness: mergeGroup(base.stillness, overrides.stillness),
    window:
      window.ms >= minimumWindowMs ? window : { ...window, ms: minimumWindowMs },
    env: mergeGroup(base.env, overrides.env),
    plausible: mergeGroup(base.plausible, overrides.plausible),
  };
}
