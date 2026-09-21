/**
 * `MiniBars` renders a gap for a `null` point, not a zero-height bar.
 *
 * A real trend has holes — an hour with no synced reading — and a zero bar reads as "measured
 * zero", which for heart rate or SpO₂ is a false and alarming claim. There is no `testID` here
 * on purpose: this repo keeps test hooks out of production components
 * (`src/__tests__/preparedness-card.test.tsx`'s note), so the slot/bar structure is read off the
 * rendered tree via `toJSON()` instead.
 */

import { render } from '@testing-library/react-native';

import { MiniBars } from '@/components/mini-bars';

describe('MiniBars', () => {
  it('renders one slot per point, all bars, when every point is numeric', async () => {
    const { toJSON } = await render(<MiniBars points={[10, 20, 30]} />);

    const container = toJSON() as { children: { children: unknown[] | null }[] };
    expect(container.children).toHaveLength(3);
    for (const slot of container.children) {
      expect(slot.children).toHaveLength(1);
    }
  });

  it('renders an empty slot — a gap — for a null point, not a bar', async () => {
    const { toJSON } = await render(<MiniBars points={[10, null, 30]} />);

    const container = toJSON() as { children: { children: unknown[] | null }[] };
    expect(container.children).toHaveLength(3);
    expect(container.children[0].children).toHaveLength(1);
    expect(container.children[1].children ?? []).toHaveLength(0);
    expect(container.children[2].children).toHaveLength(1);
  });

  it('does not throw when every point is null', async () => {
    const { toJSON } = await render(<MiniBars points={[null, null]} />);

    const container = toJSON() as { children: { children: unknown[] | null }[] };
    expect(container.children).toHaveLength(2);
    for (const slot of container.children) {
      expect(slot.children ?? []).toHaveLength(0);
    }
  });
});
