/**
 * The fixed local cohort behind the Community View demo (PRD §4, ASHA persona).
 *
 * **This is placeholder data.** No part of the app sends or receives a report; there is no
 * server, no peer discovery, and no network call on this screen. These records are constructed
 * on the device, in memory, every time the screen renders, and the participants they describe do
 * not exist. The screen says so in a banner that cannot be dismissed, and the module says so
 * here, because a fixture that reads like a feed is exactly the kind of thing that gets mistaken
 * for one six months later.
 *
 * ## Built from offsets, not from a frozen epoch
 * Every report is stamped relative to the `now` handed in, the way `environment.tsx` derives
 * everything it shows from `useNow`. A hard-coded epoch would age: the cohort would drift out of
 * the one-hour window and the screen would slowly empty out into a set of withheld rows that
 * looked like a bug in the suppression. Relative offsets keep the demo honest about *time*
 * while staying fully deterministic — same `now`, same summary, which is what the tests rely on.
 *
 * ## The cohort is shaped to make the suppression visible
 * A demo where every row publishes teaches nothing, because the interesting behaviour of
 * {@link summarizeCommunity} is what it *refuses* to say. So the counts straddle the threshold:
 *
 * | Category       | Elevated | On screen                                    |
 * | -------------- | -------- | -------------------------------------------- |
 * | heat           | 3        | published — 1 red, 2 amber, so the row is red |
 * | dehydration    | 3        | published — all amber                        |
 * | cardiovascular | 2        | **withheld**, and one of the two is red      |
 * | fatigue        | 1        | **withheld**                                 |
 * | respiratory    | 0        | **withheld** — indistinguishable from the above |
 * | fall           | 0        | **withheld**                                 |
 *
 * Cardiovascular is the row that earns the feature: there is a person at red risk in this ward
 * and the screen does not disclose it, because two is not a crowd. Respiratory and fall are the
 * other half of the argument — a true zero renders identically to a one, so a reader cannot
 * work backwards from the redaction.
 *
 * Heat and dehydration both reach 3 deliberately, so the screen shows two published rows carrying
 * different levels rather than one row and five redactions. Heat leads the headline because it is
 * listed first and ties on count — not because of its red, which would only decide the matter if
 * the milder category came first. That case is synthetic and lives in `aggregate.test.ts`; what
 * the cohort contributes is PRD §4's own example sentence.
 *
 * ## Three reports exist only to be thrown away
 * One is in a neighbouring ward, one is older than the window, and one is stamped in the future
 * as a peer with a skewed clock would be. All three are heat reports, so if the area filter, the
 * lookback, or the future-drop in `summarizeCommunity` ever stopped working, the heat count
 * would read 4, 5, or 6 — the headline would change and `demo-cohort.test.ts` would fail. The
 * filters are load-bearing for what this screen shows, so the shipped data exercises them
 * instead of leaving them to the unit tests alone.
 */

import type { RiskCategoryKey, RiskLevel } from '@/risk';

import type { AnonymizedReport } from './types';

const MINUTE_MS = 60 * 1000;

/** The demo's own ward. A named administrative area, never a coordinate — see `types.ts`. */
export const DEMO_AREA = 'Ward 4 · Nashik district';

/** A second ward, present only so the area filter has something to exclude. */
export const DEMO_NEIGHBOURING_AREA = 'Ward 7 · Nashik district';

/** Reports at `minutesAgo` before the summary instant. Negative is the future — used once, on
 *  purpose, for the clock-skew case. */
function report(
  minutesAgo: number,
  category: RiskCategoryKey,
  level: RiskLevel,
  area: string = DEMO_AREA,
): AnonymizedReport {
  return { area, category, level, reportedAt: 0 - minutesAgo * MINUTE_MS };
}

/** Offsets, resolved against `now` in {@link demoReports}. Kept as one list so the cohort can
 *  be read at a glance and counted by eye against the table above. */
const DEMO_OFFSETS: readonly AnonymizedReport[] = [
  // Heat — 3 elevated, one of them red. The headline row.
  report(4, 'heat', 'red'),
  report(11, 'heat', 'amber'),
  report(26, 'heat', 'amber'),

  // Dehydration — 3 elevated, none red. Ties heat on count and loses on level.
  report(7, 'dehydration', 'amber'),
  report(19, 'dehydration', 'amber'),
  report(38, 'dehydration', 'amber'),

  // Cardiovascular — 2 elevated. Withheld, red included.
  report(9, 'cardiovascular', 'red'),
  report(33, 'cardiovascular', 'amber'),

  // Fatigue — 1 elevated. Withheld.
  report(21, 'fatigue', 'amber'),

  // Respiratory and fall have no elevated participants at all, and so render exactly as the two
  // rows above do.

  // Green participants. They never appear in a numerator; they are why the cohort is larger
  // than the sum of the counts, and without them "3 of 14" would read as "3 of 9".
  report(2, 'heat', 'green'),
  report(13, 'respiratory', 'green'),
  report(17, 'cardiovascular', 'green'),
  report(29, 'fall', 'green'),
  report(44, 'fatigue', 'green'),

  // Excluded by design — see the module comment. Each is a heat report so a broken filter moves
  // the published heat count and fails a test.
  report(6, 'heat', 'red', DEMO_NEIGHBOURING_AREA),
  report(92, 'heat', 'red'),
  report(-5, 'heat', 'red'),
];

/** Participants the demo cohort is designed to contain in-window and in-area. Exported so the
 *  screen's "of N" and the test's expectation come from the same statement of intent. */
export const DEMO_PARTICIPANT_COUNT = 14;

/**
 * The demo cohort, stamped against `now`.
 *
 * A new array each call, by design — {@link AnonymizedReport} is deeply readonly, but handing
 * out a shared module-level array of records whose timestamps depend on an argument would be a
 * lie about which `now` produced them.
 */
export function demoReports(now: number): readonly AnonymizedReport[] {
  return DEMO_OFFSETS.map((offset) => ({ ...offset, reportedAt: now + offset.reportedAt }));
}
