/**
 * The vitals row (PRD §7.2.1 extension) — proof a deviation actually reaches the screen.
 *
 * ## Why this file exists at all
 * `src/risk/__tests__/baseline.test.ts` proves the comparison is right. `home-screen.test.tsx`
 * proves the Dashboard renders it. Neither can prove the row *changes*, because the shipped demo
 * window is a deliberately quiet fixture — its newest heart rate sits 0.2 bpm off the window mean
 * — so every state except "in line" is unreachable through the real hook. A row wired to the
 * string `In line` would pass both files. Here the readings are built per test, so rising,
 * falling, pending, unusable, and empty all render and all get asserted.
 *
 * ## Why the readings are real and the baselines are computed
 * Hand-written `BaselineDelta` objects would isolate the component perfectly and prove nothing
 * about the pair: the expected strings would be written by the test rather than by the module, so
 * a mismatch between what `baseline.ts` produces and what the card reads would be invisible. So
 * `baselinesFrom` mirrors `useRiskAssessment` exactly — one `assessRisk`, one
 * `computeVitalBaselines` over the same window — and every asserted string is one the module
 * built. The one exception is the last test, which hand-builds a single-vital object because the
 * module always emits three and a device with one sensor cannot otherwise be represented.
 */

import { render } from '@testing-library/react-native';

import { VitalsCard } from '@/components/vitals-card';
import {
  assessRisk,
  computeVitalBaselines,
  type BaselineDelta,
  type EnvironmentSnapshot,
  type SensorReading,
} from '@/risk';
import { at, reading, SECOND, stillMotion } from '@/risk/__tests__/fixtures';

const COMFORTABLE: EnvironmentSnapshot = { tempC: 24, humidity: 50 };

/** Exactly what the Dashboard hands the card, built the way the hook builds it. */
function baselinesFrom(readings: readonly SensorReading[]) {
  const assessment = assessRisk({ readings, environment: COMFORTABLE, now: at(0) });
  return {
    latest: readings.at(-1) ?? null,
    baselines: computeVitalBaselines({ readings, assessment }),
  };
}

type Vitals = { readonly hr?: number; readonly spo2?: number; readonly skinTempC?: number };

/**
 * Ten minutes at a 60-second poll: nine readings holding `history`, then one holding `current`.
 * The average is exactly the history value, so the percentage on screen is exact.
 */
function series(history: Vitals, current: Vitals = history): SensorReading[] {
  const readings: SensorReading[] = [];
  for (let index = 9; index >= 0; index -= 1) {
    const values = index === 0 ? current : history;
    readings.push(
      reading({ at: at(-index * 60 * SECOND), ...values, motionSummary: stillMotion() }),
    );
  }
  return readings;
}

const FLAT: Vitals = { hr: 80, spo2: 98, skinTempC: 34 };

describe('the vitals row reports the deviation it was given', () => {
  it('shows the rise as a percentage of the average, and says so in a sentence', async () => {
    const { getByText } = await render(
      <VitalsCard {...baselinesFrom(series(FLAT, { ...FLAT, hr: 92 }))} />,
    );

    expect(getByText('92')).toBeTruthy();
    expect(getByText('+15%')).toBeTruthy();
    expect(getByText('Heart rate is 15% above your 10-minute average.')).toBeTruthy();
  });

  it('shows a fall with a minus sign and in percentage points for SpO₂', async () => {
    const { getByText } = await render(
      <VitalsCard {...baselinesFrom(series(FLAT, { ...FLAT, spo2: 95 }))} />,
    );

    expect(getByText('-3 pts')).toBeTruthy();
    expect(getByText('SpO₂ is 3 points below your 10-minute average.')).toBeTruthy();
  });

  it('says nothing is out of line when the window has not moved', async () => {
    const { getAllByText, getByText } = await render(<VitalsCard {...baselinesFrom(series(FLAT))} />);

    // One per vital. The count is the assertion: a row that emphasised whichever vital it
    // happened to compute last would show two.
    expect(getAllByText('In line')).toHaveLength(3);
    expect(getByText('In line with your 10-minute average.')).toBeTruthy();
  });

  it('holds each vital to its own scale in one render', async () => {
    // 4 bpm and 0.4 °C in the same window: one is inside its deadband and one is not. A shared
    // threshold, or a shared emphasis rule, shows up here as all three columns agreeing.
    const { getAllByText, getByText } = await render(
      <VitalsCard {...baselinesFrom(series(FLAT, { ...FLAT, hr: 84, skinTempC: 34.4 }))} />,
    );

    expect(getAllByText('In line')).toHaveLength(2); // heart rate and SpO₂
    expect(getByText('+0.4°C')).toBeTruthy();
    expect(getByText('Skin temp is 0.4°C above your 10-minute average.')).toBeTruthy();
  });

  it('renders the three labels and units from the data rather than a fixed list', async () => {
    const { getByText } = await render(<VitalsCard {...baselinesFrom(series(FLAT))} />);

    for (const text of ['Current vitals', 'Heart rate', 'SpO₂', 'Skin temp', 'bpm', '%', '°C']) {
      expect(getByText(text)).toBeTruthy();
    }
  });
});

describe('the row when there is not enough to compare', () => {
  it('shows the numbers but no deltas until the average exists', async () => {
    // Three readings — one short of a baseline. The vitals themselves are known and shown; only
    // the comparison is withheld, which is the honest split.
    const { getAllByText, getByText } = await render(
      <VitalsCard {...baselinesFrom(series(FLAT).slice(-3))} />,
    );

    expect(getByText('80')).toBeTruthy();
    expect(getAllByText('—')).toHaveLength(3);
    expect(
      getByText('Not enough readings yet to compare against your 10-minute average.'),
    ).toBeTruthy();
  });

  it('renders an empty buffer without inventing a single number', async () => {
    // Cold start. Six placeholders: three vitals with no value and no delta. A zero anywhere
    // here would read as a heart rate of zero.
    const { getAllByText, getByText } = await render(<VitalsCard {...baselinesFrom([])} />);

    expect(getAllByText('—')).toHaveLength(6);
    expect(
      getByText('Not enough readings yet to compare against your 10-minute average.'),
    ).toBeTruthy();
    expect(getByText('Heart rate')).toBeTruthy();
  });

  it('goes quiet rather than describing a reading that has aged out', async () => {
    const stale = series(FLAT, { ...FLAT, hr: 92 }).map((sample) => ({
      ...sample,
      timestamp: sample.timestamp - 5 * 60 * SECOND,
    }));
    const { getAllByText, queryByText } = await render(<VitalsCard {...baselinesFrom(stale)} />);

    expect(queryByText('+15%')).toBeNull();
    expect(getAllByText('—')).toHaveLength(3);
  });
});

describe('the big number and the sentence under it describe the same reading', () => {
  it('shows the newest reading the engine accepted, not one it refused', async () => {
    // The contradiction this pairing exists to prevent: 400 bpm in 28-point type over "in line
    // with your 10-minute average" reads as an endorsement of a number the engine has already
    // thrown out. The last usable reading is shown instead, and the sentence beside it is then
    // true of the number above it.
    const artifact = series(FLAT, { ...FLAT, hr: 400 });
    const { getAllByText, getByText, queryByText } = await render(
      <VitalsCard {...baselinesFrom(artifact)} />,
    );

    expect(queryByText('400')).toBeNull();
    expect(getByText('80')).toBeTruthy();
    // The rejected reading leaves the comparison intact — it is measured against the last
    // usable value, which has not moved — so all three columns read in line.
    expect(getAllByText('In line')).toHaveLength(3);
  });

  it('shows an implausible reading when it is the only thing the sensor has produced', async () => {
    // The other half. Nothing in the window is usable, so there is no honest number to prefer —
    // and a blank column would suggest a sensor that reported nothing, which is a different
    // fault with a different fix. The delta line carries the explanation.
    const stuck = series({ ...FLAT, hr: 400 });
    const { getByText } = await render(<VitalsCard {...baselinesFrom(stuck)} />);

    expect(getByText('400')).toBeTruthy();
    expect(getByText('—').props.accessibilityLabel).toBe(
      'Recent heart-rate readings were unusable, so there is no average to compare against.',
    );
    // The other two vitals are fine, so the headline speaks for them rather than reporting a
    // fault the whole row does not have.
    expect(getByText('In line with your 10-minute average.')).toBeTruthy();
  });

  it('puts the full sentence on the delta line for a screen reader', async () => {
    // "+15%" announced on its own says nothing about what it is 15 % of.
    const { getByText } = await render(
      <VitalsCard {...baselinesFrom(series(FLAT, { ...FLAT, hr: 92 }))} />,
    );

    expect(getByText('+15%').props.accessibilityLabel).toBe(
      'Heart rate is 15% above your 10-minute average.',
    );
  });
});

describe('the row is a map over what it is given', () => {
  it('renders one column per vital in the data, not three by construction', async () => {
    // Hand-built, because `computeVitalBaselines` always emits three and a device with a heart
    // rate sensor and nothing else cannot be produced from readings. Three hardcoded columns
    // would render two empty ones here — or crash reaching for `vitals[1]`.
    const onlyHeartRate: BaselineDelta = {
      field: 'hr',
      label: 'Heart rate',
      unit: 'bpm',
      report: 'percent',
      current: 92,
      baseline: 80,
      delta: 12,
      percentDelta: 15,
      direction: 'above',
      meaningful: true,
      short: '+15%',
      summary: 'Heart rate is 15% above your 10-minute average.',
      dataQuality: 'ok',
      sampleCount: 10,
      baselineCount: 9,
      noiseMultiple: 12 / 7,
    };

    const { getByText, queryByText } = await render(
      <VitalsCard
        latest={null}
        baselines={{
          windowMs: 10 * 60 * SECOND,
          windowLabel: '10-minute',
          evaluatedAt: at(0),
          vitals: [onlyHeartRate],
          headline: onlyHeartRate.summary,
        }}
      />,
    );

    expect(getByText('+15%')).toBeTruthy();
    expect(queryByText('SpO₂')).toBeNull();
    expect(queryByText('Skin temp')).toBeNull();
  });
});
