/**
 * `RiskCard`, and the environmental-context block in particular.
 *
 * The card had no test file at all, which was tolerable while it was a pure function of a
 * fixture. It stopped being tolerable when the card grew the one block on the Dashboard whose
 * correctness is a *claim about the engine* rather than about layout: "Environmental context
 * only — it is not included in the score or status above."
 *
 * A UI test cannot check that sentence by looking at itself. So the block below does not build a
 * fixture: it runs the real engine over two windows that differ **only** in AQI, renders the real
 * card for each, and asserts three things at once — the block appears on the polluted one, the
 * score and the status word are identical across the pair, and the disclaimer that says exactly
 * that is on screen. If someone later folds `envMultiplier` into `score` (the option E5
 * rejected), the scores diverge and this fails, which is the point: the label and the arithmetic
 * are pinned together in one assertion rather than in two files that can drift.
 */

import { render } from '@testing-library/react-native';

import { RiskCard } from '@/components/risk-card';
import type { RiskCategory } from '@/constants/health-data';
import {
  assessRisk,
  fahrenheitToCelsius,
  ENV_CONTEXT_DISCLAIMER,
  type EnvironmentSnapshot,
} from '@/risk';
import { at, healthySeries, MINUTE, series } from '@/risk/__tests__/fixtures';

/** Clean air and comfortable heat: the control for every pair below. */
const CLEAN: EnvironmentSnapshot = { tempC: 24, humidity: 50, aqi: 40 };
/** Same weather, hazardous air. Only `aqi` differs, so only `envMultiplier` may differ. */
const POLLUTED: EnvironmentSnapshot = { tempC: 24, humidity: 50, aqi: 300 };

/**
 * Readings that score **non-zero** on respiratory, which is the whole reason this helper exists
 * instead of `healthySeries()`.
 *
 * `healthySeries()` carries SpO₂ 98, and `scoreFor` maps anything at or above 97 to exactly 0.
 * Zero is a fixed point of multiplication: `0 × 1.3 === 0`. A "the score did not move" assertion
 * built on it would therefore pass *even if someone did fold the multiplier in*, which is the
 * one regression this file exists to catch — a green test proving nothing.
 *
 * SpO₂ 94 sits mid-band (97 → 0, 92 → 39, so roughly 23). Still green, so the status word is
 * unchanged and the card is directly comparable, but a number the multiplier would visibly move.
 */
function borderlineSeries() {
  return series({ count: 6, everyMs: MINUTE, endingAt: at(0), hr: 72, spo2: 94, skinTempC: 34 });
}

function respiratoryUnder(environment: EnvironmentSnapshot) {
  return assessRisk({ readings: borderlineSeries(), environment }).byCategory.respiratory;
}

describe('the environmental context block', () => {
  it('appears on the respiratory card when the air is bad, naming the factor and the uplift', async () => {
    const respiratory = respiratoryUnder(POLLUTED);
    // Guard the premise: if the engine ever stopped computing this, the render assertions below
    // would pass vacuously by finding nothing and asserting nothing.
    expect(respiratory.envMultiplier).toBeCloseTo(1.3, 5);

    const { getByText } = await render(<RiskCard category={respiratory} />);

    expect(getByText('Environmental context')).toBeTruthy();
    expect(getByText('Air quality +30%')).toBeTruthy();
    expect(getByText(ENV_CONTEXT_DISCLAIMER)).toBeTruthy();
  });

  it('is absent when the air is clean, rather than rendering "+0%"', async () => {
    const { queryByText } = await render(<RiskCard category={respiratoryUnder(CLEAN)} />);

    expect(queryByText('Environmental context')).toBeNull();
    expect(queryByText(ENV_CONTEXT_DISCLAIMER)).toBeNull();
  });

  it('tells the truth: the score and the status word do not move when the multiplier does', async () => {
    // The assertion the disclaimer's honesty rests on. Same readings, same weather, different
    // AQI — the multiplier changes, the verdict must not. AQI reaches nothing else in the engine
    // (it appears only inside `airQualityMultiplier`), so any divergence here is the multiplier
    // leaking into the score.
    const clean = respiratoryUnder(CLEAN);
    const polluted = respiratoryUnder(POLLUTED);

    // Without this the rest is vacuous — see `borderlineSeries` on why zero would pass anyway.
    expect(clean.score).toBeGreaterThan(0);

    expect(polluted.envMultiplier).toBeGreaterThan(clean.envMultiplier);
    expect(polluted.score).toBe(clean.score);
    expect(polluted.level).toBe(clean.level);
    expect(polluted.tier).toBe(clean.tier);
    expect(polluted.guidance).toBe(clean.guidance);
    expect(polluted.flagged).toBe(clean.flagged);

    // And the same through the rendered card, which is where the user meets the claim: the status
    // word and the metric line are identical on both, while only the polluted one carries the
    // context block.
    const cleanCard = await render(<RiskCard category={clean} />);
    expect(cleanCard.getByText('Normal')).toBeTruthy();
    expect(cleanCard.getByText(clean.metric)).toBeTruthy();
    await cleanCard.unmount();

    const pollutedCard = await render(<RiskCard category={polluted} />);
    expect(pollutedCard.getByText('Normal')).toBeTruthy();
    expect(pollutedCard.getByText(clean.metric)).toBeTruthy();
    expect(pollutedCard.getByText(ENV_CONTEXT_DISCLAIMER)).toBeTruthy();
  });

  it('appears on the cardiovascular card from heat, with its own factor name', async () => {
    // Heat index supplied directly (rather than solved from temp/humidity) so the case sits
    // squarely past the 103 °F heat-stress flag that arms `heatFlagMultiplier`, exactly as
    // `assess.test.ts` does it.
    //
    // No score-equality assertion for this pair, and deliberately so: unlike AQI, heat is read
    // elsewhere in the engine, so a difference between a hot and a cool assessment need not mean
    // the multiplier leaked. The respiratory pair above is the clean experiment.
    const hot = assessRisk({
      readings: healthySeries(),
      environment: { tempC: 30, humidity: 50, heatIndexC: fahrenheitToCelsius(110) },
    }).byCategory.cardiovascular;
    expect(hot.envMultiplier).toBeCloseTo(1.2, 5);

    const { getByText } = await render(<RiskCard category={hot} />);

    expect(getByText('Environmental context')).toBeTruthy();
    expect(getByText('Heat +20%')).toBeTruthy();
    expect(getByText(ENV_CONTEXT_DISCLAIMER)).toBeTruthy();
  });

  it('is absent from the categories that take no environmental input', async () => {
    // Heat is the source of amplification, not a recipient; dehydration already has the heat
    // load inside its own conjunction; fall and fatigue read no weather at all.
    const assessment = assessRisk({ readings: borderlineSeries(), environment: POLLUTED });
    for (const key of ['heat', 'fall', 'dehydration', 'fatigue'] as const) {
      const screen = await render(<RiskCard category={assessment.byCategory[key]} />);
      expect(screen.queryByText('Environmental context')).toBeNull();
      await screen.unmount();
    }
  });
});

describe('the card still renders what it always did', () => {
  const FIXTURE: RiskCategory = {
    key: 'heat',
    label: 'Heat Stress',
    level: 'amber',
    guidance: 'Stay in the shade and drink water.',
    actions: ['Move somewhere cooler', 'Drink a glass of water'],
    metric: 'Heat index 39°C',
  };

  it('shows label, status word, guidance, every action, and the metric', async () => {
    const { getByText } = await render(<RiskCard category={FIXTURE} />);

    expect(getByText('Heat Stress')).toBeTruthy();
    expect(getByText('Caution')).toBeTruthy();
    expect(getByText('Stay in the shade and drink water.')).toBeTruthy();
    expect(getByText('Move somewhere cooler')).toBeTruthy();
    expect(getByText('Drink a glass of water')).toBeTruthy();
    expect(getByText('Heat index 39°C')).toBeTruthy();
  });

  it('renders a bare RiskCategory — no actions, no metric, no context — without inventing any', async () => {
    // The hand-built fixture case: `RiskCategory` has no `envMultiplier` field, so the new block
    // must be absent rather than throwing on a missing property.
    const { getByText, queryByText } = await render(
      <RiskCard
        category={{ key: 'fall', label: 'Fall Detection', level: 'green', guidance: 'All clear.' }}
      />,
    );

    expect(getByText('All clear.')).toBeTruthy();
    expect(getByText('Normal')).toBeTruthy();
    expect(queryByText('Environmental context')).toBeNull();
  });
});
