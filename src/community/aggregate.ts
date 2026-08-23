/**
 * Small-count suppression for the Community View (PRD §4, ASHA persona).
 *
 * The screen above this is a concept demonstration, but this file is not decorative. Turning a
 * set of individual reports into a publishable count is the one part of a community feature that
 * has a correct and an incorrect answer, and the incorrect answer re-identifies people. So the
 * aggregation is a pure function with its own tests, on the same terms as the risk rules: no
 * clock, no I/O, no module state, `now` passed in.
 *
 * ## k-anonymity, and what the threshold is actually protecting
 * A count of 1 is not an aggregate. "1 nearby person at elevated cardiovascular risk" published
 * to a ward of forty is a sentence about a specific person, and in a household of six it names
 * them outright. So a count is published only once at least {@link MIN_REPORTABLE_COUNT}
 * participants are in it, and below that the row is **withheld** rather than shown as a number.
 *
 * Two consequences that are easy to get wrong, and both are the whole point:
 *
 * - **Withheld covers 0, 1, and 2 without distinguishing them.** Rendering a true zero as "0"
 *   and a one as "withheld" makes the withheld rows mean "at least one, fewer than three" — the
 *   suppression would then *announce* the presence it exists to hide, and an observer learns
 *   more from the redaction than from a number. Every sub-threshold count leaves this function
 *   as the same `null`.
 * - **A withheld count publishes no level either.** See {@link CategoryTally}: `red` beside a
 *   withheld count discloses that someone is at red.
 *
 * ## Why the cohort size is suppressed too
 * Participants are a count like any other, and a small one is worse than useless: published
 * alongside six withheld rows, a cohort of 2 bounds every one of them to {0, 1, 2} out of 2.
 * Suppression that holds per row and leaks in aggregate is not suppression, so the same
 * threshold applies to the denominator.
 *
 * ## What this deliberately does not attempt
 * Real k-anonymity over a stream needs more than a per-tick threshold: repeated publication of
 * an overlapping cohort lets a differencing attack recover an individual across ticks, which is
 * what differential privacy addresses and a fixed `k` does not. A single-shot local demo cannot
 * exhibit that attack — there is no history and no second observer — and pretending otherwise
 * with an ε parameter would be theatre. The gap is named here so a later networked version
 * treats it as unfinished rather than done.
 */

import { CATEGORY_LABELS, type RiskCategoryKey, type RiskLevel } from '@/risk';

import type { AnonymizedReport, CategoryTally, CommunitySummary } from './types';

/**
 * Smallest count that may be published as a number.
 *
 * 3 is the conventional floor for small-count suppression in public health reporting, and it is
 * a floor rather than a considered optimum: the defensible `k` for a real deployment depends on
 * the population of the smallest area published, and a ward small enough makes even 3 a
 * disclosure. Exposed as `minReportableCount` on {@link summarizeCommunity} so raising it is a
 * caller's decision.
 */
export const MIN_REPORTABLE_COUNT = 3;

/** Lookback the summary describes. An hour: long enough to accumulate a cohort, short enough
 *  that "elevated now" is still true when a health worker reads it. */
export const DEFAULT_COMMUNITY_WINDOW_MS = 60 * 60 * 1000;

/**
 * Row order, matching the Dashboard's cards.
 *
 * Declared rather than derived from `Object.keys(CATEGORY_LABELS)` so the order is a decision
 * instead of an artifact of object literal ordering. `aggregate.test.ts` asserts it covers every
 * category exactly once, which is what makes a seventh category added to the engine fail a test
 * here rather than silently never appear on this screen.
 */
export const COMMUNITY_CATEGORY_ORDER: readonly RiskCategoryKey[] = [
  'heat',
  'respiratory',
  'cardiovascular',
  'fall',
  'dehydration',
  'fatigue',
];

/**
 * How each category reads inside the headline sentence.
 *
 * Separate from `CATEGORY_LABELS` because a card title and a mid-sentence noun are not the same
 * register: "3 nearby people at elevated Heat Stress risk" is a label wedged into prose. The
 * labels still own the row titles, so the two cannot drift apart on which categories exist.
 */
const CATEGORY_PHRASES: Readonly<Record<RiskCategoryKey, string>> = {
  heat: 'heat',
  respiratory: 'breathing',
  cardiovascular: 'heart-rate',
  fall: 'fall',
  dehydration: 'dehydration',
  fatigue: 'fatigue',
};

/** Severity ranking, for picking the worst level in a bucket. */
const LEVEL_RANK: Readonly<Record<RiskLevel, number>> = { green: 0, amber: 1, red: 2 };

export type SummarizeOptions = {
  /** Instant the window ends at. Required — this module never reads a clock. */
  readonly now: number;
  /** Area to summarize. Reports from anywhere else are not this ward's business. */
  readonly area: string;
  readonly windowMs?: number;
  /** Overridable so the boundary can be tested from both sides, and so a smaller ward can
   *  demand a larger `k` without editing this file. */
  readonly minReportableCount?: number;
};

/** A report belongs to this summary. Mirrors `withinWindow` in the risk engine — `(now −
 *  windowMs, now]`, future-dated dropped, because a peer's skewed clock should not be able to
 *  inflate a count for the rest of the day. */
function isInScope(report: AnonymizedReport, area: string, oldest: number, now: number): boolean {
  return (
    report.area === area && report.reportedAt > oldest && report.reportedAt <= now
  );
}

/** `count` if publishable, else `null`. The single place the threshold is applied. */
function publishable(count: number, minReportableCount: number): number | null {
  return count >= minReportableCount ? count : null;
}

/**
 * Aggregate reports into a publishable area summary.
 *
 * Every count in the result has already passed the threshold; nothing downstream needs to know
 * the rule, and no screen can accidentally render a raw one.
 */
export function summarizeCommunity(
  reports: readonly AnonymizedReport[],
  options: SummarizeOptions,
): CommunitySummary {
  const {
    now,
    area,
    windowMs = DEFAULT_COMMUNITY_WINDOW_MS,
    minReportableCount = MIN_REPORTABLE_COUNT,
  } = options;

  const oldest = now - windowMs;
  const inScope = reports.filter((report) => isInScope(report, area, oldest, now));

  // Counted per category with the worst level seen, over elevated reports only. A green
  // participant is part of the cohort — they are why the denominator is larger than the
  // numerators — but they are not "at elevated risk" in any category.
  const elevatedCounts = new Map<RiskCategoryKey, { count: number; level: RiskLevel }>();
  for (const report of inScope) {
    if (report.level === 'green') continue;
    const previous = elevatedCounts.get(report.category);
    if (previous === undefined) {
      elevatedCounts.set(report.category, { count: 1, level: report.level });
      continue;
    }
    elevatedCounts.set(report.category, {
      count: previous.count + 1,
      level: LEVEL_RANK[report.level] > LEVEL_RANK[previous.level] ? report.level : previous.level,
    });
  }

  const tallies: CategoryTally[] = COMMUNITY_CATEGORY_ORDER.map((category) => {
    const bucket = elevatedCounts.get(category);
    const count = publishable(bucket?.count ?? 0, minReportableCount);
    return {
      category,
      label: CATEGORY_LABELS[category],
      // Withheld together, never separately — publishing the level of a withheld bucket is the
      // disclosure the suppression exists to prevent.
      level: count === null ? null : (bucket?.level ?? null),
      count,
    };
  });

  return {
    area,
    generatedAt: now,
    windowMs,
    suppressionThreshold: minReportableCount,
    participants: publishable(inScope.length, minReportableCount),
    tallies,
    headline: buildHeadline(tallies),
  };
}

/**
 * The one line worth leading with, or `null` when nothing may be published.
 *
 * Largest published count wins, worst level breaks the tie, then row order — so the headline is
 * a deterministic function of the tallies and not of the input's arrival order. Only published
 * counts are eligible, which means the headline cannot leak what the rows withheld.
 *
 * PRD §4's example reads "3 nearby users at elevated heat risk"; the wording here says *people*,
 * because the reader is a health worker planning visits and the subject of that sentence is
 * someone they will knock on the door of.
 */
function buildHeadline(tallies: readonly CategoryTally[]): string | null {
  let best: CategoryTally | null = null;
  for (const tally of tallies) {
    if (tally.count === null) continue;
    if (best === null || best.count === null) {
      best = tally;
      continue;
    }
    if (tally.count > best.count) {
      best = tally;
      continue;
    }
    if (
      tally.count === best.count &&
      LEVEL_RANK[tally.level ?? 'green'] > LEVEL_RANK[best.level ?? 'green']
    ) {
      best = tally;
    }
  }

  if (best === null || best.count === null) return null;
  const people = best.count === 1 ? 'person' : 'people';
  return `${best.count} nearby ${people} at elevated ${CATEGORY_PHRASES[best.category]} risk`;
}

/** Rows whose count was withheld. Rendered as a group, so the screen can say how many
 *  categories are being held back without saying anything about what is in them. */
export function withheldTallies(summary: CommunitySummary): readonly CategoryTally[] {
  return summary.tallies.filter((tally) => tally.count === null);
}

/** Rows with a publishable count, in row order. */
export function publishedTallies(summary: CommunitySummary): readonly CategoryTally[] {
  return summary.tallies.filter((tally) => tally.count !== null);
}
