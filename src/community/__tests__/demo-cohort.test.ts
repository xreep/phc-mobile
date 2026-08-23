/**
 * The shipped demo cohort (PRD §4, ASHA persona).
 *
 * `aggregate.test.ts` proves the suppression is correct for arbitrary input. This file proves the
 * cohort actually *demonstrates* it — that the figures a reviewer sees on the Community tab are
 * the ones the module comment claims, and in particular that some rows are withheld. A demo
 * whose every row published would show the feature working and teach nothing about what it does.
 *
 * The three out-of-scope reports are pinned here too. They exist so the area filter, the
 * lookback, and the future-drop are load-bearing for what the screen renders rather than only
 * for what the unit tests assert — so a regression in any of them changes the heat count and
 * fails below.
 */

import {
  DEMO_AREA,
  DEMO_NEIGHBOURING_AREA,
  DEMO_PARTICIPANT_COUNT,
  demoReports,
  MIN_REPORTABLE_COUNT,
  publishedTallies,
  summarizeCommunity,
  withheldTallies,
} from '@/community';
import type { RiskCategoryKey } from '@/risk';

import { MINUTE, T0 } from '../../risk/__tests__/fixtures';

const NOW = T0;

function summary(now = NOW) {
  return summarizeCommunity(demoReports(now), { now, area: DEMO_AREA });
}

function countFor(category: RiskCategoryKey): number | null {
  return summary().tallies.find((row) => row.category === category)?.count ?? null;
}

describe('the demo cohort', () => {
  it('has the participant count the screen states', () => {
    // The banner says "14 placeholder participants". If the cohort changes and this does not,
    // the screen is lying about its own fixture.
    expect(summary().participants).toBe(DEMO_PARTICIPANT_COUNT);
  });

  it('publishes heat and dehydration and withholds everything else', () => {
    expect(publishedTallies(summary()).map((row) => row.category)).toEqual([
      'heat',
      'dehydration',
    ]);
    expect(withheldTallies(summary()).map((row) => row.category)).toEqual([
      'respiratory',
      'cardiovascular',
      'fall',
      'fatigue',
    ]);
  });

  it('shows PRD §4’s own example sentence', () => {
    expect(summary().headline).toBe('3 nearby people at elevated heat risk');
  });

  it('ties dehydration on count, and publishes a different level for each', () => {
    // Heat leads the headline on row order here, not on severity — the two categories tie at 3
    // and heat is listed first, so it would win either way. The severity tiebreak is exercised
    // in `aggregate.test.ts`, where the milder category comes first on purpose.
    //
    // What this cohort does prove is that two published rows can carry different levels, so the
    // chips on screen are not all the same colour.
    expect(countFor('heat')).toBe(3);
    expect(countFor('dehydration')).toBe(3);
    expect(summary().tallies.find((row) => row.category === 'heat')?.level).toBe('red');
    expect(summary().tallies.find((row) => row.category === 'dehydration')?.level).toBe('amber');
  });

  it('hides a red participant in a sub-threshold category', () => {
    // The row that earns the feature: someone in this ward is at red cardiovascular risk and the
    // screen discloses neither the count nor the severity.
    const row = summary().tallies.find((r) => r.category === 'cardiovascular');
    expect(row?.count).toBeNull();
    expect(row?.level).toBeNull();
    expect(demoReports(NOW).some((r) => r.category === 'cardiovascular' && r.level === 'red')).toBe(
      true,
    );
  });

  it('makes a true zero indistinguishable from a one', () => {
    // Respiratory has no elevated participant; fatigue has exactly one. Identical on screen.
    const rows = summary().tallies;
    const respiratory = rows.find((r) => r.category === 'respiratory');
    const fatigue = rows.find((r) => r.category === 'fatigue');
    expect(respiratory?.count).toBeNull();
    expect(fatigue?.count).toBeNull();
    expect(respiratory?.level).toBe(fatigue?.level);
  });

  it('holds back more rows than it publishes, so the suppression is what the demo shows', () => {
    expect(withheldTallies(summary()).length).toBeGreaterThan(publishedTallies(summary()).length);
  });
});

describe('the reports that exist to be discarded', () => {
  const excluded = () => {
    const all = demoReports(NOW);
    return {
      otherWard: all.filter((r) => r.area === DEMO_NEIGHBOURING_AREA),
      tooOld: all.filter((r) => r.reportedAt <= NOW - 60 * MINUTE),
      future: all.filter((r) => r.reportedAt > NOW),
    };
  };

  it('includes one report from a neighbouring ward', () => {
    expect(excluded().otherWard).toHaveLength(1);
  });

  it('includes one report older than the window', () => {
    expect(excluded().tooOld).toHaveLength(1);
  });

  it('includes one report stamped in the future', () => {
    expect(excluded().future).toHaveLength(1);
  });

  it('would change the published heat count if any filter stopped working', () => {
    // All three are heat reports, and heat publishes at 3. Admitting any of them moves the count
    // and the headline with it — which is the point of siting them in the shipped fixture.
    const { otherWard, tooOld, future } = excluded();
    for (const report of [...otherWard, ...tooOld, ...future]) {
      expect(report.category).toBe('heat');
      expect(report.level).not.toBe('green');
    }
    expect(otherWard.length + tooOld.length + future.length).toBe(3);
  });

  it('leaves the cohort above the threshold without them', () => {
    expect(DEMO_PARTICIPANT_COUNT).toBeGreaterThanOrEqual(MIN_REPORTABLE_COUNT);
    expect(demoReports(NOW)).toHaveLength(DEMO_PARTICIPANT_COUNT + 3);
  });
});

describe('relative stamping', () => {
  it('produces the same summary at any instant, so the demo never ages out', () => {
    // The reason the offsets are relative rather than a frozen epoch: a year from now this screen
    // must still show the cohort rather than six withheld rows that look like a broken filter.
    const muchLater = NOW + 400 * 24 * 60 * MINUTE;
    const now = summary();
    const later = summary(muchLater);

    expect(later.headline).toBe(now.headline);
    expect(later.participants).toBe(now.participants);
    expect(later.tallies).toEqual(now.tallies);
  });

  it('stamps every report against the instant it was given', () => {
    const shifted = demoReports(NOW + MINUTE);
    const base = demoReports(NOW);
    shifted.forEach((report, index) => {
      expect(report.reportedAt).toBe(base[index].reportedAt + MINUTE);
    });
  });

  it('returns a fresh array rather than a shared one', () => {
    expect(demoReports(NOW)).not.toBe(demoReports(NOW));
    expect(demoReports(NOW)).toEqual(demoReports(NOW));
  });
});
