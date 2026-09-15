/**
 * Small-count suppression (PRD §4, ASHA persona).
 *
 * The screen this feeds is a concept demonstration; these assertions are not. Everything here
 * describes a disclosure that would be real the moment the cohort were, so each test is written
 * as the leak it forbids rather than as the field it checks.
 *
 * Timestamps come from the risk engine's fixtures — same fixed epoch, same prohibition on
 * `Date.now()`, for the same reason: a window rule tested against a real clock is a window rule
 * tested against a different window every run.
 */

import {
  COMMUNITY_CATEGORY_ORDER,
  DEFAULT_COMMUNITY_WINDOW_MS,
  MIN_REPORTABLE_COUNT,
  publishedTallies,
  summarizeCommunity,
  withheldTallies,
  type AnonymizedReport,
  type CategoryTally,
} from '@/community';
import { CATEGORY_LABELS, type RiskCategoryKey, type RiskLevel } from '@/risk';

import { MINUTE, T0 } from '../../risk/__tests__/fixtures';

const AREA = 'Ward 4';
const ELSEWHERE = 'Ward 7';

/** Summary instant every test is anchored to. */
const NOW = T0;

function report(
  category: RiskCategoryKey,
  level: RiskLevel,
  minutesAgo = 1,
  area = AREA,
): AnonymizedReport {
  return { area, category, level, reportedAt: NOW - minutesAgo * MINUTE };
}

/** `count` copies of one report. The only way to cross the threshold, so it earns a helper. */
function reports(
  count: number,
  category: RiskCategoryKey,
  level: RiskLevel,
  area = AREA,
): AnonymizedReport[] {
  return Array.from({ length: count }, (_, index) => report(category, level, index + 1, area));
}

function summarize(input: readonly AnonymizedReport[], overrides = {}) {
  return summarizeCommunity(input, { now: NOW, area: AREA, ...overrides });
}

function tally(input: readonly AnonymizedReport[], category: RiskCategoryKey): CategoryTally {
  const found = summarize(input).tallies.find((row) => row.category === category);
  if (found === undefined) throw new Error(`no row for ${category}`);
  return found;
}

describe('row coverage', () => {
  // A category added to the engine and not to `COMMUNITY_CATEGORY_ORDER` would simply never
  // appear on this screen — no error, no empty row, just a risk the ward is never told about.
  it('orders exactly the engine categories, once each', () => {
    expect([...COMMUNITY_CATEGORY_ORDER].sort()).toEqual(Object.keys(CATEGORY_LABELS).sort());
  });

  it('emits every category even when the cohort is empty, so a quiet row is visible', () => {
    const summary = summarize([]);
    expect(summary.tallies.map((row) => row.category)).toEqual(COMMUNITY_CATEGORY_ORDER);
  });

  it('titles rows from the engine labels, so a row and a Dashboard card agree', () => {
    for (const row of summarize([]).tallies) {
      expect(row.label).toBe(CATEGORY_LABELS[row.category]);
    }
  });
});

describe('the suppression threshold', () => {
  it(`withholds a count of ${MIN_REPORTABLE_COUNT - 1}`, () => {
    expect(tally(reports(MIN_REPORTABLE_COUNT - 1, 'heat', 'amber'), 'heat').count).toBeNull();
  });

  it(`publishes a count of exactly ${MIN_REPORTABLE_COUNT}`, () => {
    expect(tally(reports(MIN_REPORTABLE_COUNT, 'heat', 'amber'), 'heat').count).toBe(
      MIN_REPORTABLE_COUNT,
    );
  });

  it('renders a true zero and a one identically, so the redaction discloses nothing', () => {
    // The whole argument for `null` over `0`. If an empty row read "0" and a single participant
    // read "withheld", every withheld row would mean "at least one person" — the suppression
    // would announce the presence it exists to hide.
    const zero = tally([], 'fall');
    const one = tally(reports(1, 'fall', 'red'), 'fall');
    expect(one).toEqual(zero);
  });

  it('never publishes the level of a withheld count', () => {
    // A red among two participants is the case that matters: someone in this ward is in trouble
    // and the screen must not say so.
    const row = tally([report('cardiovascular', 'red'), report('cardiovascular', 'amber', 5)], 'cardiovascular');
    expect(row.count).toBeNull();
    expect(row.level).toBeNull();
  });

  it('is a caller-supplied floor, so a smaller ward can demand more', () => {
    const input = reports(4, 'heat', 'amber');
    expect(tally(input, 'heat').count).toBe(4);
    expect(summarize(input, { minReportableCount: 5 }).tallies[0].count).toBeNull();
  });
});

describe('the cohort size', () => {
  it('counts green participants, who are in no numerator', () => {
    const summary = summarize([
      ...reports(3, 'heat', 'amber'),
      ...reports(4, 'respiratory', 'green'),
    ]);
    expect(summary.participants).toBe(7);
    expect(summary.tallies.find((row) => row.category === 'respiratory')?.count).toBeNull();
  });

  it('is itself withheld below the threshold', () => {
    // Published as 2 beside six withheld rows, the denominator would bound every one of them to
    // {0, 1, 2} out of 2 — suppression that holds per row and leaks in aggregate.
    expect(summarize(reports(2, 'heat', 'red')).participants).toBeNull();
  });

  it('is at least the sum of the published counts', () => {
    // One report per participant (see `types.ts`), so the counts are addable. If a participant
    // could appear in two categories this would fail, which is the property worth pinning.
    const summary = summarize([
      ...reports(3, 'heat', 'amber'),
      ...reports(3, 'dehydration', 'amber'),
    ]);
    const total = summary.tallies.reduce((sum, row) => sum + (row.count ?? 0), 0);
    expect(summary.participants).toBeGreaterThanOrEqual(total);
  });
});

describe('scope', () => {
  it('ignores another ward, however alarming', () => {
    const summary = summarize(reports(5, 'heat', 'red', ELSEWHERE));
    expect(summary.participants).toBeNull();
    expect(summary.headline).toBeNull();
  });

  it('drops reports older than the window', () => {
    const stale = 61; // window is 60 minutes
    const input = [
      ...reports(3, 'heat', 'amber'),
      report('heat', 'red', stale),
      report('heat', 'red', stale + 30),
    ];
    expect(tally(input, 'heat').count).toBe(3);
  });

  it('excludes a report at the exact window edge and includes the one after it', () => {
    const edge = { category: 'heat' as const, level: 'amber' as const, area: AREA };
    const onEdge = { ...edge, reportedAt: NOW - DEFAULT_COMMUNITY_WINDOW_MS };
    const justInside = { ...edge, reportedAt: NOW - DEFAULT_COMMUNITY_WINDOW_MS + 1 };

    // `(now − windowMs, now]`, matching `withinWindow` in the risk engine.
    //
    // Threshold lowered to 1 deliberately. At the real `k` of 3 a one-millisecond error at the
    // boundary is invisible — both sides of it suppress to `null` — so this assertion would pass
    // against a `>=` and pin nothing. The suppression is what the other tests are for; this one
    // is about the interval.
    const loose = { minReportableCount: 1 };
    expect(summarize([onEdge], loose).participants).toBeNull();
    expect(summarize([justInside], loose).participants).toBe(1);
    expect(summarize([onEdge, justInside], loose).tallies[0].count).toBe(1);
  });

  it('drops future-dated reports, so a skewed peer clock cannot inflate a count', () => {
    const input = [
      ...reports(3, 'heat', 'amber'),
      { area: AREA, category: 'heat' as const, level: 'red' as const, reportedAt: NOW + MINUTE },
    ];
    expect(tally(input, 'heat').count).toBe(3);
  });

  it('includes a report stamped exactly now', () => {
    const atNow = { area: AREA, category: 'heat' as const, level: 'amber' as const, reportedAt: NOW };
    expect(summarize([atNow, atNow, atNow]).tallies[0].count).toBe(3);
  });

  it('reports the window and threshold it used, since a count means nothing without them', () => {
    const summary = summarize([], { windowMs: 5 * MINUTE, minReportableCount: 7 });
    expect(summary.windowMs).toBe(5 * MINUTE);
    expect(summary.suppressionThreshold).toBe(7);
    expect(summary.generatedAt).toBe(NOW);
    expect(summary.area).toBe(AREA);
  });
});

describe('published levels', () => {
  it('reports the worst level in the bucket, not the most common', () => {
    const row = tally(
      [report('heat', 'amber', 1), report('heat', 'amber', 2), report('heat', 'red', 3)],
      'heat',
    );
    expect(row.count).toBe(3);
    expect(row.level).toBe('red');
  });

  it('does not let a green participant set a category level', () => {
    const row = tally(
      [...reports(3, 'fatigue', 'amber'), report('fatigue', 'green', 9)],
      'fatigue',
    );
    expect(row.level).toBe('amber');
    expect(row.count).toBe(3);
  });
});

describe('the headline', () => {
  it('names the largest published count', () => {
    const summary = summarize([
      ...reports(3, 'heat', 'amber'),
      ...reports(4, 'dehydration', 'amber'),
    ]);
    expect(summary.headline).toBe('4 nearby people at elevated dehydration risk');
  });

  it('breaks a tie on severity even when the milder category is listed first', () => {
    // Cardiovascular precedes fatigue in row order, so this is the only arrangement that
    // actually exercises the severity tiebreak: a tie where the worse category also happens to
    // come first is settled by order alone and would pass with the tiebreak deleted.
    const summary = summarize([
      ...reports(3, 'cardiovascular', 'amber'),
      report('fatigue', 'red', 1),
      report('fatigue', 'red', 2),
      report('fatigue', 'red', 3),
    ]);
    expect(summary.headline).toBe('3 nearby people at elevated fatigue risk');
  });

  it('falls back to row order when count and severity both tie', () => {
    const summary = summarize([
      ...reports(3, 'heat', 'amber'),
      ...reports(3, 'dehydration', 'amber'),
    ]);
    expect(summary.headline).toBe('3 nearby people at elevated heat risk');
  });

  it('is null when every row is withheld', () => {
    // Nothing may be said, so nothing is said — rather than a cheerful "all clear" that would be
    // false with two people at red risk.
    const summary = summarize([...reports(2, 'heat', 'red'), ...reports(2, 'fall', 'red')]);
    expect(summary.headline).toBeNull();
  });

  it('is null for an empty cohort', () => {
    expect(summarize([]).headline).toBeNull();
  });

  it('never names a withheld category', () => {
    const summary = summarize([...reports(3, 'heat', 'amber'), ...reports(2, 'fall', 'red')]);
    expect(summary.headline).toBe('3 nearby people at elevated heat risk');
  });

  it('does not depend on the order reports arrive in', () => {
    const input = [...reports(3, 'heat', 'amber'), ...reports(3, 'fatigue', 'amber')];
    expect(summarize(input).headline).toBe(summarize([...input].reverse()).headline);
  });

  it('says "person" when a lowered threshold makes a count of one publishable', () => {
    const summary = summarize(reports(1, 'fall', 'red'), { minReportableCount: 1 });
    expect(summary.headline).toBe('1 nearby person at elevated fall risk');
  });
});

describe('the row partitions', () => {
  it('split every row into published or withheld, with nothing lost', () => {
    const summary = summarize([...reports(3, 'heat', 'amber'), ...reports(2, 'fall', 'red')]);
    const published = publishedTallies(summary);
    const withheld = withheldTallies(summary);

    expect(published.map((row) => row.category)).toEqual(['heat']);
    expect(withheld.length + published.length).toBe(summary.tallies.length);
    expect(withheld.every((row) => row.count === null)).toBe(true);
  });
});

describe('purity', () => {
  it('does not read a clock — the same input and `now` give the same summary', () => {
    const input = [...reports(3, 'heat', 'amber'), ...reports(2, 'fall', 'red')];
    expect(summarize(input)).toEqual(summarize(input));
  });

  it('does not mutate the reports it is given', () => {
    const input = reports(3, 'heat', 'amber');
    const before = JSON.stringify(input);
    summarize(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is anchored to the supplied instant, not to T0 by accident', () => {
    const later = T0 + 5 * 60 * MINUTE;
    const shifted = reports(3, 'heat', 'amber').map((r) => ({
      ...r,
      reportedAt: r.reportedAt + 5 * 60 * MINUTE,
    }));
    const summary = summarizeCommunity(shifted, { now: later, area: AREA });
    expect(summary.tallies[0].count).toBe(3);
    expect(summary.generatedAt).toBe(later);
  });
});
