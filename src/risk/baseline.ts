/**
 * Personal baseline tracking (PRD §7.2.1 extension) — the newest reading held against the
 * rolling average of the window it was drawn from.
 *
 * ## What this is for
 * A heart rate of 78 bpm means nothing on its own. It means something once you know the person
 * has been sitting at 66 all morning. The Dashboard already shows the number; this module
 * supplies the only context available without a profile, a server, or any history beyond the
 * buffer the engine already holds — the window's own average.
 *
 * ## Why it is not a rule
 * Nothing here fires, flags, scores, or escalates. `assessRisk` owns every judgement the app
 * makes; this is a *description* of the same readings, and it deliberately produces no
 * `RuleOutcome`, no `RuleId`, and no level. That separation is what keeps a deviation from
 * quietly becoming a second, undocumented risk signal sitting beside the six real ones.
 *
 * ## Why it takes the assessment rather than a `now`
 * The comparison has to be over *the* current sensor window, not over a window that merely
 * resembles it. If this module resolved its own `now` and its own `windowMs`, a caller who
 * passed thresholds to `assessRisk` and forgot them here would get a Dashboard whose vitals row
 * described a different span than its cards — and nothing would say so. Taking
 * `assessment.evaluatedAt` and `assessment.windowMs` makes that divergence unrepresentable
 * instead of merely unlikely.
 *
 * ## The horizons on screen are not all the same, and the strings say so
 * `window.ms` is 10 minutes. The dehydration advisory looks back 15 and fatigue 18, each with
 * its own baseline, so a heart rate that has been elevated for nine minutes reads as *in line*
 * here while the dehydration card reports a 22 bpm rise. Both are true: one is a comparison
 * against the last ten minutes, the other against the quarter-hour before that. Every string
 * this module produces therefore names its horizon — "your 10-minute average" — and the label
 * is derived from `windowMs` rather than written out, so it cannot drift from the number it
 * describes. `__tests__/baseline.test.ts` pins that pair on purpose.
 *
 * ## Why each vital is reported in a different unit
 * The brief's example is "HR 15% above your recent average", and for heart rate a percentage is
 * exactly right: bpm is a ratio scale with a true zero, so 15 % more of it is a meaningful
 * quantity. Reusing that form for the other two would be a category error.
 *
 * - **SpO₂** is already a percentage. "3 % below" invites the reader to compute 3 % of 97 and
 *   arrive at the wrong number; the difference between 97 % and 94 % is three *points*, and that
 *   is what oximetry is discussed in everywhere it is discussed carefully.
 * - **Skin temperature** in °C is an interval scale, not a ratio scale — its zero is a
 *   convention, not an absence of heat. "5 % above 34 °C" is not 1.7 °C of anything; the same
 *   physical rise expressed in °F would come out as a different percentage. Degrees, therefore.
 *
 * ## Why there is a deadband at all
 * `config.ts` argues, for three separate thresholds, that consumer optical HR carries roughly
 * 7 bpm of resting error and that "a threshold inside the noise floor is not a threshold". The
 * same sentence applies to a *reported difference*: "Heart rate is 3 % above your 10-minute
 * average" on a 77 bpm baseline is 2.3 bpm, which is the sensor talking, not the user's
 * physiology. Below the deadband the card says so plainly rather than dressing noise up as a
 * finding.
 */

import { resolveRiskThresholds } from './config';
import type {
  DataQuality,
  PartialRiskThresholds,
  RiskAssessment,
  RiskThresholds,
  SensorReading,
} from './types';
import { collectSamples, latestSample, withinWindow, type VitalField } from './window';

/** Which side of the baseline the current reading sits on, or neither. */
export type BaselineDirection = 'above' | 'below' | 'level';

/** How a vital's difference from its baseline is expressed. See the file header. */
export type BaselineReport = 'percent' | 'points' | 'degrees';

export type BaselineDelta = {
  readonly field: VitalField;
  /** Column heading and sentence subject, matching the Dashboard's stat label exactly. */
  readonly label: string;
  readonly unit: string;
  readonly report: BaselineReport;
  /** The newest usable reading — the same number the Dashboard shows in large type. */
  readonly current: number | null;
  /** Mean of the in-window samples *before* the newest one. `null` until there are enough. */
  readonly baseline: number | null;
  /** `current − baseline`, in the vital's own unit. */
  readonly delta: number | null;
  /** Only ever set for a ratio-scale vital — heart rate. `null` for SpO₂ and skin temp. */
  readonly percentDelta: number | null;
  readonly direction: BaselineDirection;
  /** Cleared the deadband **and** rests on a fresh reading. The card only speaks when true. */
  readonly meaningful: boolean;
  /** Compact form for the stat column: `+15%`, `-3 pts`, `+0.4°C`, or `—`. */
  readonly short: string;
  /** One sentence, naming the horizon. Safe to render in any state. */
  readonly summary: string;
  readonly dataQuality: DataQuality;
  /** Usable in-window samples for this vital, including the newest. */
  readonly sampleCount: number;
  /** How many samples formed the mean. */
  readonly baselineCount: number;
  /**
   * `|delta|` in deadband widths — how far out this vital is in units of its own noise floor.
   *
   * The only unit-free quantity the three vitals share, and therefore the only defensible way
   * to rank a 3-point SpO₂ drop against a 0.4 °C rise. `0` when there is no baseline.
   */
  readonly noiseMultiple: number;
};

export type VitalBaselines = {
  /** Taken from the assessment, so it is the same window the cards were computed over. */
  readonly windowMs: number;
  /** Human form of {@link windowMs} — `10-minute`. Derived, never written out. */
  readonly windowLabel: string;
  readonly evaluatedAt: number;
  /** Heart rate, SpO₂, skin temperature — the Dashboard's stat order. */
  readonly vitals: readonly BaselineDelta[];
  /** The one line the Dashboard puts under the stat row. Always a complete sentence. */
  readonly headline: string;
};

export type VitalBaselineInput = {
  /**
   * The same buffer handed to `assessRisk`. Order does not matter; it is sorted here, and
   * future-dated readings are dropped by {@link withinWindow}.
   */
  readonly readings: readonly SensorReading[];
  /** Supplies `now` and the window, so the two cannot disagree. See the file header. */
  readonly assessment: RiskAssessment;
  readonly thresholds?: PartialRiskThresholds;
};

type DeadbandKey = 'minDeltaBpm' | 'minDeltaSpo2Pct' | 'minDeltaSkinTempC';

type VitalDescriptor = {
  readonly field: VitalField;
  readonly label: string;
  /** Mid-sentence form, so "for a heart-rate baseline" does not read as a proper noun. */
  readonly phrase: string;
  readonly unit: string;
  readonly report: BaselineReport;
  readonly deadbandKey: DeadbandKey;
};

/** Dashboard order. `plausible` is keyed by {@link VitalField}, so the range comes for free. */
const VITALS: readonly VitalDescriptor[] = [
  {
    field: 'hr',
    label: 'Heart rate',
    phrase: 'heart-rate',
    unit: 'bpm',
    report: 'percent',
    deadbandKey: 'minDeltaBpm',
  },
  {
    field: 'spo2',
    label: 'SpO₂',
    phrase: 'SpO₂',
    unit: '%',
    report: 'points',
    deadbandKey: 'minDeltaSpo2Pct',
  },
  {
    field: 'skinTempC',
    label: 'Skin temp',
    phrase: 'skin-temperature',
    unit: '°C',
    report: 'degrees',
    deadbandKey: 'minDeltaSkinTempC',
  },
];

/** Placeholder for a delta there is no basis to state. Matches the Dashboard's own. */
const ABSENT = '—';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * `10-minute`, from 600000.
 *
 * Rounded to whole minutes because the label appears mid-sentence and "9.7-minute average"
 * reads as a machine talking. Falls back to seconds below a minute so a test or a caller that
 * shrinks the window still gets a sentence rather than "0-minute".
 */
export function formatWindowLabel(windowMs: number): string {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 'recent';
  if (windowMs < MINUTE_MS) return `${Math.max(1, Math.round(windowMs / SECOND_MS))}-second`;
  return `${Math.round(windowMs / MINUTE_MS)}-minute`;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Unsigned magnitude in the vital's reporting unit.
 *
 * Two forms, because a column and a sentence want different things: the stat row has about four
 * characters to work with, and "SpO₂ is 3 pts below your 10-minute average" reads like a
 * spreadsheet. Only the points form actually differs — a percent sign and a degree symbol are
 * already the words.
 */
function formatMagnitude(
  report: BaselineReport,
  delta: number,
  percentDelta: number | null,
  form: 'short' | 'sentence',
): string {
  switch (report) {
    case 'percent':
      // `percentDelta` is null only if the baseline is non-positive, which `plausible.hr` makes
      // impossible — but falling back to bpm is the honest answer rather than a crash.
      return percentDelta === null
        ? `${Math.round(Math.abs(delta))} bpm`
        : `${Math.round(Math.abs(percentDelta))}%`;
    case 'points': {
      const points = Math.round(Math.abs(delta));
      if (form === 'short') return `${points} pts`;
      return `${points} point${points === 1 ? '' : 's'}`;
    }
    case 'degrees':
      return `${Math.abs(delta).toFixed(1)}°C`;
  }
}

/**
 * One vital's comparison. Pure, and total: every branch produces a renderable sentence, because
 * a Dashboard that shows a blank line when the evidence is thin looks broken rather than honest.
 */
function deltaFor(
  descriptor: VitalDescriptor,
  readings: readonly SensorReading[],
  now: number,
  thresholds: RiskThresholds,
  windowLabel: string,
): BaselineDelta {
  const { field, label, phrase, unit, report, deadbandKey } = descriptor;
  const { baseline: config, plausible, window } = thresholds;

  const { samples, rejected } = collectSamples(readings, field, plausible[field]);
  const latest = latestSample(samples);

  const base = {
    field,
    label,
    unit,
    report,
    sampleCount: samples.length,
  } as const;

  if (latest === null) {
    return {
      ...base,
      current: null,
      baseline: null,
      delta: null,
      percentDelta: null,
      direction: 'level',
      meaningful: false,
      short: ABSENT,
      summary:
        rejected > 0
          ? `Recent ${phrase} readings were unusable, so there is no average to compare against.`
          : `No ${phrase} readings to average.`,
      dataQuality: 'missing',
      baselineCount: 0,
      noiseMultiple: 0,
    };
  }

  const isStale = now - latest.timestamp > window.maxStaleMs;

  // The newest sample is excluded from its own baseline. Including it damps every difference by
  // 1/n — 5 % at twenty samples — and makes the card quietly self-referential; `dehydration.ts`
  // excludes its newest slice for the same reason.
  const history = samples.slice(0, -1);
  const haveBaseline = history.length >= config.minBaselineSamples;
  const baselineValue = haveBaseline ? mean(history.map((sample) => sample.value)) : null;

  if (baselineValue === null) {
    return {
      ...base,
      current: latest.value,
      baseline: null,
      delta: null,
      percentDelta: null,
      direction: 'level',
      meaningful: false,
      short: ABSENT,
      // Says which of the two thin-evidence states this is, rather than the generic "—" the
      // stat column shows. A user who waits four more polls gets a number; one whose sensor
      // is dropping readings does not, and the two deserve different sentences.
      summary: `Not enough readings yet for a ${phrase} baseline.`,
      dataQuality: 'partial',
      baselineCount: history.length,
      noiseMultiple: 0,
    };
  }

  const delta = latest.value - baselineValue;
  const percentDelta =
    report === 'percent' && baselineValue > 0 ? (delta / baselineValue) * 100 : null;

  const deadband = config[deadbandKey];
  const noiseMultiple = deadband > 0 ? Math.abs(delta) / deadband : 0;
  const clearsDeadband = Math.abs(delta) >= deadband;
  // A difference measured against a reading that has aged out is not a difference worth
  // stating: the "current" half of the comparison is no longer current. The numbers stay on
  // the object for any consumer that wants them; the card just stops speaking.
  const meaningful = clearsDeadband && !isStale;

  const dataQuality: DataQuality = isStale
    ? 'stale'
    : rejected > 0 || samples.length < window.minSamples
      ? 'partial'
      : 'ok';

  const magnitude = formatMagnitude(report, delta, percentDelta, 'short');
  const direction: BaselineDirection = !meaningful ? 'level' : delta > 0 ? 'above' : 'below';

  const summary = isStale
    ? `Recent ${phrase} readings are out of date.`
    : meaningful
      ? `${label} is ${formatMagnitude(report, delta, percentDelta, 'sentence')} ${direction} your ${windowLabel} average.`
      : `${label} is in line with your ${windowLabel} average.`;

  return {
    ...base,
    current: latest.value,
    baseline: baselineValue,
    delta,
    percentDelta,
    direction,
    meaningful,
    short: meaningful ? `${delta > 0 ? '+' : '-'}${magnitude}` : isStale ? ABSENT : 'In line',
    summary,
    dataQuality,
    baselineCount: history.length,
    noiseMultiple,
  };
}

/**
 * Compare the newest reading of each vital against its own rolling average.
 *
 * Everything is derived from `readings` and `assessment` — there is no stored profile and no
 * hardcoded average anywhere in this module, which is the point of PRD §7.2.1's extension.
 */
export function computeVitalBaselines(input: VitalBaselineInput): VitalBaselines {
  const thresholds = resolveRiskThresholds(input.thresholds);
  const now = input.assessment.evaluatedAt;
  const windowMs = input.assessment.windowMs;
  const windowLabel = formatWindowLabel(windowMs);

  const readings = withinWindow(input.readings, now, windowMs);
  const vitals = VITALS.map((descriptor) =>
    deltaFor(descriptor, readings, now, thresholds, windowLabel),
  );

  // Ranked by deadband widths, not by raw magnitude — 0.4 °C and 3 points are otherwise
  // incomparable, and sorting by the raw number would let skin temperature never win.
  const notable = vitals
    .filter((vital) => vital.meaningful)
    .sort((a, b) => b.noiseMultiple - a.noiseMultiple)[0];

  const headline =
    notable !== undefined
      ? notable.summary
      : vitals.some((vital) => vital.baseline !== null)
        ? // Deliberately does not say "all three": on a device missing a sensor only one vital
          // has a baseline, and claiming three would be an overstatement the data cannot back.
          `In line with your ${windowLabel} average.`
        : `Not enough readings yet to compare against your ${windowLabel} average.`;

  return { windowMs, windowLabel, evaluatedAt: now, vitals, headline };
}
