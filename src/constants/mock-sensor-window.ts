/**
 * A rolling sensor window synthesised from the demo constants in `health-data.ts`,
 * so the Dashboard can run the real Tier-1 risk engine (PRD §7.2.2) instead of
 * showing hardcoded card levels.
 *
 * ## Why this is a separate file
 * `health-data.ts` imports nothing, and that is load-bearing rather than incidental:
 * `src/risk/types.ts` takes three *types* from it and documents that as the engine's
 * only coupling to the app, which is what keeps the engine runtime-dependency-free and
 * unit-testable without a device. Putting a builder that imports `@/risk` into
 * `health-data.ts` would close that import into a cycle. So the demo values stay there
 * and the assembly happens here.
 *
 * ## Why a builder rather than a constant
 * Every duration rule in the engine compares timestamps against `now`, and the
 * freshness bounds are short — `window.maxStaleMs` is three minutes. A fixed array of
 * epoch timestamps would therefore be reported `stale` by every rule within minutes of
 * being written, and the demo would degrade into "no recent reading" cards. Anchoring
 * the window to a caller-supplied `now` keeps it fresh while staying a pure function,
 * so tests can pin an exact instant and get an exact assessment.
 *
 * None of this is a sensor. When PRD §7.2.1 ingestion lands it replaces these two
 * functions with the real ring buffer and the cached weather observation; the engine
 * call site does not change.
 */

import { ENVIRONMENT, VITALS } from '@/constants/health-data';
import type { EnvironmentSnapshot, MotionSummary, SensorReading } from '@/risk';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * Spacing between synthetic readings. PRD §7.2.1 polls Health Connect every 30–60 s,
 * and testing at 1 Hz instead is what previously hid two thresholds that could never
 * be satisfied on real hardware, so the demo window uses the real cadence.
 */
const INTERVAL_MS = 60 * SECOND;

/**
 * How stale the newest reading is: half a polling interval, i.e. the ordinary state of a
 * buffer that is being polled every 60 s. Well inside `window.maxStaleMs` (3 min), so
 * every vitals category reports `dataQuality: 'ok'`.
 *
 * This value is not free to choose. PRD §7.2.5's collapse escalation needs a *trailing*
 * still run over `stillness.heatCriticalMs` (10 min), measured between readings inside
 * the engine's 12-minute extended lookback; the lookback's `maxGapMs` (2 min) of headroom
 * therefore has to cover both this lag and the half-open boundary's one-sample epsilon.
 * At a 60 s cadence that leaves the escalation reachable only while this stays **under**
 * 60 s — at exactly 60 s the achievable span is 10 min and the rule's `>` test fails.
 * `mock-sensor-window.test.ts` pins that boundary so the demo cannot drift into the
 * regime where a safety rule is silently unsatisfiable.
 */
const LATEST_AGE_MS = 30 * SECOND;

/** Matches `ENVIRONMENT.updatedAt`'s "12 min ago" — well inside `env.maxStaleMs`
 *  (60 min), which is deliberately far looser than the vitals bound because a weather
 *  observation half an hour old is still current while a heart rate is not. */
const ENVIRONMENT_AGE_MS = 12 * MINUTE;

/**
 * Number of readings. The engine's longest lookback is
 * `stillness.heatCriticalMs + window.maxGapMs` = 12 min (PRD §7.2.5 needs to see ten
 * minutes of stillness *and* prove the readings were continuous), so the window has to
 * reach at least that far back or the extended-lookback rules silently see a short
 * buffer. Twenty one-minute samples reach 21 min, leaving real headroom.
 */
const SAMPLE_COUNT = 20;

/**
 * Accelerometer aggregates, in g with gravity included, in the two shapes the
 * stillness predicates actually distinguish.
 *
 * `ACTIVE` is not still because its *peak* exceeds `fall.stillnessPeakG` (1.4), not
 * because its mean is off — a walking user's mean magnitude sits near 1 g since gravity
 * dominates, which is exactly why the engine bounds the peak as well as the mean. It is
 * still far below `fall.impactG` (2.5), so it is movement, not an impact.
 */
const ACTIVE: MotionSummary = { peakG: 1.62, minG: 0.74, rmsG: 1.06, sampleCount: 60 };
const STILL: MotionSummary = { peakG: 1.04, minG: 0.97, rmsG: 1.0, sampleCount: 60 };

/**
 * Oldest → newest, one entry per reading. Values are ordinary and unremarkable on
 * purpose: the demo's one red card should come from the environment, so that anyone
 * reading the output can tell the heat flag apart from a physiological one.
 *
 * The series is deliberately *not* uniform. A constant series makes several distinct
 * bugs invisible — the newest sample coincides with the window's peak, so a rule that
 * scores off the wrong one still looks right — and that is precisely how a
 * flagged-but-green defect survived a green test suite earlier in this engine's life.
 */
const HR_BPM = [
  74, 76, 75, 77, 79, 81, 80, 77, 75, 76, 78, 80, 79, 77, 76, 78, 79, 77, 76, VITALS.hr,
];
const SPO2_PCT = [
  98, 97, 98, 97, 96, 97, 97, 98, 97, 96, 97, 98, 97, 97, 96, 97, 98, 97, 98, VITALS.spo2,
];
const SKIN_TEMP_C = [
  36.6, 36.7, 36.7, 36.8, 36.9, 36.9, 36.8, 36.7, 36.7, 36.8, 36.8, 36.9, 36.8, 36.8, 36.7, 36.8,
  36.9, 36.8, 36.7, VITALS.skinTempC,
];

/**
 * Sat down for a while, then got up.
 *
 * The trailing samples must be `ACTIVE`. At this demo's heat index — 56.4 °C, which is
 * NOAA Extreme Danger — a *trailing* still run over `stillness.heatCriticalMs` (10 min)
 * satisfies PRD §7.2.5's "extreme heat index with no motion for > 10 min", which fires
 * `heat.stillness.critical` and makes the assessment an SOS candidate. That is the
 * correct reading of such data, which is the point: the demo shows a person moving about
 * in dangerous heat, not one who has collapsed in it. Flipping the tail to `STILL` turns
 * this dashboard into an emergency, and `mock-sensor-window.test.ts` asserts both
 * directions — the escalation firing on a still tail is what proves the green fall card
 * here is a real negative rather than an unreachable rule.
 *
 * The still stretch in the middle is 7 min of span. It is deliberately *not* trailing:
 * genuine stillness that the engine measures and reports, that correctly does not
 * escalate because the person has since got up.
 */
const MOTION: readonly MotionSummary[] = [
  ACTIVE, ACTIVE, ACTIVE, ACTIVE, ACTIVE, ACTIVE,
  STILL, STILL, STILL, STILL, STILL, STILL, STILL, STILL,
  ACTIVE, ACTIVE, ACTIVE, ACTIVE, ACTIVE, ACTIVE,
];

/**
 * The demo's rolling sensor buffer, oldest → newest, as PRD §7.2.1's unified schema.
 *
 * @param now Evaluation instant in epoch ms. The newest reading lands
 *   `LATEST_AGE_MS` before it, so the window is fresh relative to whatever the caller
 *   is about to pass to `assessRisk`.
 */
export function buildMockReadings(now: number): SensorReading[] {
  const newest = now - LATEST_AGE_MS;
  const oldestIndex = SAMPLE_COUNT - 1;

  return Array.from({ length: SAMPLE_COUNT }, (_unused, index) => ({
    source: 'simulated' as const,
    timestamp: newest - (oldestIndex - index) * INTERVAL_MS,
    hr: HR_BPM[index],
    spo2: SPO2_PCT[index],
    skinTempC: SKIN_TEMP_C[index],
    motionSummary: MOTION[index],
  }));
}

/**
 * The demo's weather observation, narrowed to what the engine consumes.
 *
 * Built field by field rather than spread from `ENVIRONMENT`, because most of that
 * constant — location, advisories, the pre-banded labels — is presentation the engine
 * must not read. `heatIndexC` is forwarded since a real provider's value outranks one
 * derived from a single temperature/humidity pair, and the engine re-bands it against
 * NOAA either way.
 */
export function buildMockEnvironment(now: number): EnvironmentSnapshot {
  return {
    tempC: ENVIRONMENT.tempC,
    humidity: ENVIRONMENT.humidity,
    heatIndexC: ENVIRONMENT.heatIndexC,
    aqi: ENVIRONMENT.aqi,
    observedAt: now - ENVIRONMENT_AGE_MS,
  };
}

/** Exported for the tests that pin the demo's intended output. */
export const MOCK_WINDOW = {
  intervalMs: INTERVAL_MS,
  latestAgeMs: LATEST_AGE_MS,
  environmentAgeMs: ENVIRONMENT_AGE_MS,
  sampleCount: SAMPLE_COUNT,
  spanMs: (SAMPLE_COUNT - 1) * INTERVAL_MS,
  active: ACTIVE,
  still: STILL,
} as const;
