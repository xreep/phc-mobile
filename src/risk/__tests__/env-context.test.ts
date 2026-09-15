/**
 * `environmentalContextFor` — the label must match the behaviour.
 *
 * This is the E5 contract in one file. The engine computes `envMultiplier` for the respiratory
 * and cardiovascular categories and, by documented design, never folds it into `score`
 * (`CategoryAssessment.envMultiplier`, `risk/index.ts`). The card was therefore hiding a factor
 * it tracked; the fix is to show it, labelled as context that does *not* move the score. That
 * label is only honest if two things hold, and they are the two things pinned here:
 *
 *   1. the block appears exactly when there is a real (>= 1%) environmental uplift, on exactly
 *      the two categories that have one — never on heat/fall/dehydration/fatigue, never on a
 *      plain `RiskCategory` with no multiplier at all; and
 *   2. every block it produces carries the disclaimer, and the disclaimer names both the score
 *      and the status, because the card shows the status as a coloured word and the score only
 *      through it.
 *
 * The companion assertion — that the score genuinely is unchanged when the multiplier moves —
 * lives at the engine level in `assess.test.ts` ("does not let air quality inflate the
 * respiratory score") and is re-pinned through the rendered card in `risk-card.test.tsx`. Here
 * we prove the *copy* is only shown when it is true.
 */

import {
  environmentalContextFor,
  ENV_CONTEXT_DISCLAIMER,
  type EnvironmentalContext,
} from '../env-context';
import type { RiskCategoryKey } from '../types';

/** The two categories with an environmental input, and the four without. */
const AMPLIFIED: RiskCategoryKey[] = ['respiratory', 'cardiovascular'];
const UNAMPLIFIED: RiskCategoryKey[] = ['heat', 'fall', 'dehydration', 'fatigue'];

describe('when there is nothing honest to say, it says nothing', () => {
  it('returns null for a plain RiskCategory carrying no multiplier at all', () => {
    // The Dashboard passes `CategoryAssessment` (which has `envMultiplier`), but the same card
    // renders hand-built `RiskCategory` fixtures that do not. Those must not crash or invent a
    // block — `undefined` is "no signal", not "1×".
    expect(environmentalContextFor({ key: 'respiratory' })).toBeNull();
  });

  it('returns null at the neutral multiplier, when the air is clean', () => {
    for (const key of AMPLIFIED) {
      expect(environmentalContextFor({ key, envMultiplier: 1 })).toBeNull();
    }
  });

  it.each(UNAMPLIFIED)('returns null for %s however high the multiplier', (key) => {
    // These four never receive amplification by design (heat is the source; dehydration already
    // has the heat load in its conjunction; fall and fatigue read no weather). Even a stray
    // non-1 value must not surface copy for them — the mapping, not the number, decides.
    expect(environmentalContextFor({ key, envMultiplier: 1.3 })).toBeNull();
  });

  it('returns null for a sub-1% uplift, so a continuous ramp does not render "about 0%"', () => {
    // `airQualityMultiplier` ramps continuously from AQI 100, so just above the neutral bound it
    // is a fraction of a percent. Below half a percent that rounds to 0 and is noise; at or above
    // one percent it is the first figure worth a sentence.
    //
    // The exact 1.005 midpoint is deliberately *not* pinned here. `(1.005 - 1) * 100` is
    // 0.4999999999999996 in IEEE-754, so which way it rounds is a fact about binary floating
    // point rather than about this rule, and a test asserting either answer would be pinning the
    // representation. The values below sit clear of that edge in both directions.
    expect(environmentalContextFor({ key: 'respiratory', envMultiplier: 1.004 })).toBeNull();
    expect(environmentalContextFor({ key: 'respiratory', envMultiplier: 1.006 })?.percent).toBe(1);
  });

  it('returns null for a non-finite multiplier rather than propagating NaN into copy', () => {
    expect(environmentalContextFor({ key: 'respiratory', envMultiplier: NaN })).toBeNull();
    expect(environmentalContextFor({ key: 'cardiovascular', envMultiplier: Infinity })).toBeNull();
  });
});

describe('when there is a real uplift, the block is present and self-disclaiming', () => {
  it('surfaces air quality for respiratory, with the engine percentage', () => {
    const context = environmentalContextFor({ key: 'respiratory', envMultiplier: 1.3 });
    expect(context).not.toBeNull();
    const ctx = context as EnvironmentalContext;
    expect(ctx.factor).toBe('Air quality');
    expect(ctx.percent).toBe(30);
    expect(ctx.multiplier).toBe(1.3);
    expect(ctx.detail).toContain('30%');
    expect(ctx.detail.toLowerCase()).toContain('air quality');
  });

  it('surfaces heat for cardiovascular', () => {
    const context = environmentalContextFor({ key: 'cardiovascular', envMultiplier: 1.2 });
    const ctx = context as EnvironmentalContext;
    expect(ctx.factor).toBe('Heat');
    expect(ctx.percent).toBe(20);
    expect(ctx.detail).toContain('20%');
    expect(ctx.detail.toLowerCase()).toContain('heat');
  });

  it('carries the disclaimer verbatim on every block, naming both score and status', () => {
    for (const key of AMPLIFIED) {
      const ctx = environmentalContextFor({ key, envMultiplier: 1.25 }) as EnvironmentalContext;
      expect(ctx.disclaimer).toBe(ENV_CONTEXT_DISCLAIMER);
    }
    // The disclaimer is only load-bearing if it disclaims the two things the card shows.
    expect(ENV_CONTEXT_DISCLAIMER).toMatch(/not included in the score/i);
    expect(ENV_CONTEXT_DISCLAIMER).toMatch(/status/i);
    expect(ENV_CONTEXT_DISCLAIMER).toMatch(/body readings/i);
  });

  it('never claims the context lowers risk — the uplift is always an addition', () => {
    // The copy says "adding about N%"; a multiplier below 1 would make that a lie. The engine
    // only ever produces >= 1 (both ramps start at 1 and climb), and this guards the copy against
    // a future multiplier that did not.
    const ctx = environmentalContextFor({
      key: 'respiratory',
      envMultiplier: 1.3,
    }) as EnvironmentalContext;
    expect(ctx.percent).toBeGreaterThanOrEqual(1);
    expect(ctx.detail).not.toMatch(/reduc|lower|less/i);
  });
});
