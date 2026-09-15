/**
 * `PreparednessCard` — the card must not be mistakable for a live risk card.
 *
 * The content itself is guarded in `advisories/__tests__/preparedness.test.ts`. What this file
 * pins is the rendering, and specifically the three things that separate this card from the live
 * heat and air-quality cards it sits beneath on the Environment screen:
 *
 *   1. the disclaimer is on the card, not in a section footnote, and it is present in both the
 *      collapsed and the expanded state — a reader who never opens the card still sees it;
 *   2. the badge is the neutral "General advisory" and never a traffic-light status word, because
 *      there is no measurement here to derive a level from; and
 *   3. the steps are behind a labelled toggle, so the fixed text cannot push the live measurements
 *      off the top of the screen.
 *
 * The negative assertions are the load-bearing ones. `RiskCard`'s status vocabulary is
 * Normal/Caution/Alert, and any of those three words appearing on this card would state a verdict
 * the content cannot support — so they are asserted absent rather than merely not written.
 */

import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import {
  PREPAREDNESS_ADVISORIES,
  PREPAREDNESS_BADGE,
  PREPAREDNESS_DISCLAIMER,
  stepCount,
  type PreparednessAdvisory,
} from '@/advisories';
import { PreparednessCard } from '@/components/preparedness-card';
import { RiskColors } from '@/constants/theme';

function advisory(id: 'flood' | 'cyclone'): PreparednessAdvisory {
  const found = PREPAREDNESS_ADVISORIES.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no ${id} advisory`);
  return found;
}

const FLOOD = advisory('flood');
const CYCLONE = advisory('cyclone');

describe('collapsed, which is how it first renders', () => {
  it('shows the title, the neutral badge, the disclaimer, and the summary', async () => {
    const { getByText } = await render(<PreparednessCard advisory={FLOOD} />);

    expect(getByText('Flood')).toBeTruthy();
    expect(getByText(PREPAREDNESS_BADGE)).toBeTruthy();
    expect(getByText(PREPAREDNESS_DISCLAIMER)).toBeTruthy();
    expect(getByText(FLOOD.summary)).toBeTruthy();
  });

  it('holds the steps back behind a toggle that says how many there are', async () => {
    const { getByText, queryByText } = await render(<PreparednessCard advisory={FLOOD} />);

    expect(getByText(`Show steps (${stepCount(FLOOD)})`)).toBeTruthy();
    // The count is user-visible copy, so pin the number as well as the shape.
    expect(getByText('Show steps (12)')).toBeTruthy();

    for (const section of FLOOD.sections) {
      expect(queryByText(section.heading)).toBeNull();
      for (const step of section.steps) expect(queryByText(step)).toBeNull();
    }
  });

  it('carries no traffic-light status word, so it cannot read as a verdict', async () => {
    // `RiskCard`'s entire status vocabulary. Each is a claim about a measurement, and this card
    // has none to make.
    const { queryByText } = await render(<PreparednessCard advisory={FLOOD} />);

    for (const word of ['Normal', 'Caution', 'Alert']) {
      expect(queryByText(word)).toBeNull();
    }
  });

  it('tints the badge neutral, not with any of the three level colours', async () => {
    // The word-absence test above does not cover this. Swapping `risk.neutral` for `risk.red` in
    // the component would leave every string identical and every other assertion in this file
    // green, while putting an alarm-coloured chip on content that has measured nothing — so the
    // colour is pinned as a value rather than left to review.
    //
    // Read by walking up from the badge text rather than by adding a `testID`: this repo keeps
    // test hooks out of its production components (the only `testID`s in `src/` are inside a test
    // file), and a style is observable without one.
    const { getByText } = await render(<PreparednessCard advisory={FLOOD} />);

    const pill = StyleSheet.flatten(getByText(PREPAREDNESS_BADGE).parent?.props.style);

    expect(pill.backgroundColor).toBe(RiskColors.light.neutral.bg);
    for (const level of ['green', 'amber', 'red'] as const) {
      expect(pill.backgroundColor).not.toBe(RiskColors.light[level].bg);
    }
  });
});

describe('expanded', () => {
  it('reveals every section heading, risk sentence, and step', async () => {
    const screen = await render(<PreparednessCard advisory={FLOOD} />);

    await fireEvent.press(screen.getByLabelText('Show flood advisory steps'));

    for (const section of FLOOD.sections) {
      expect(screen.getByText(section.heading)).toBeTruthy();
      // The risk sentence is asserted alongside the steps because it is the half that says *why* —
      // dropping it in a rewrite would leave instructions with no stated reason.
      expect(screen.getByText(section.risk)).toBeTruthy();
      for (const step of section.steps) expect(screen.getByText(step)).toBeTruthy();
    }
  });

  it('still shows the disclaimer, which is the state a reader spends longest in', async () => {
    const screen = await render(<PreparednessCard advisory={CYCLONE} />);

    await fireEvent.press(screen.getByLabelText('Show cyclone advisory steps'));

    expect(screen.getByText(PREPAREDNESS_DISCLAIMER)).toBeTruthy();
    expect(screen.getByText(PREPAREDNESS_BADGE)).toBeTruthy();
  });

  it('collapses again, and reports its state to assistive technology both ways', async () => {
    const screen = await render(<PreparednessCard advisory={CYCLONE} />);

    const closed = screen.getByLabelText('Show cyclone advisory steps');
    expect(closed.props.accessibilityState).toMatchObject({ expanded: false });

    await fireEvent.press(closed);

    const open = screen.getByLabelText('Hide cyclone advisory steps');
    expect(open.props.accessibilityState).toMatchObject({ expanded: true });
    expect(screen.getByText('Hide steps')).toBeTruthy();

    await fireEvent.press(open);

    expect(screen.getByText(`Show steps (${stepCount(CYCLONE)})`)).toBeTruthy();
    expect(screen.queryByText(CYCLONE.sections[0].heading)).toBeNull();
  });

  it('names the hazard in the toggle label, since two cards share the screen', async () => {
    // Two identically-labelled buttons is the failure this prevents: a screen-reader user hearing
    // "Show steps" twice cannot tell which hazard they are opening.
    const flood = await render(<PreparednessCard advisory={FLOOD} />);
    expect(flood.getByLabelText('Show flood advisory steps')).toBeTruthy();
    await flood.unmount();

    const cyclone = await render(<PreparednessCard advisory={CYCLONE} />);
    expect(cyclone.getByLabelText('Show cyclone advisory steps')).toBeTruthy();
  });
});

describe('both advisories render on the same terms', () => {
  it.each(PREPAREDNESS_ADVISORIES.map((item) => [item.id, item] as const))(
    '%s carries the badge and the disclaimer',
    async (_id, item) => {
      const screen = await render(<PreparednessCard advisory={item} />);

      expect(screen.getByText(item.title)).toBeTruthy();
      expect(screen.getByText(PREPAREDNESS_BADGE)).toBeTruthy();
      expect(screen.getByText(PREPAREDNESS_DISCLAIMER)).toBeTruthy();
      await screen.unmount();
    },
  );
});
