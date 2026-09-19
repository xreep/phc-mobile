/**
 * Alert-planner tests (M3 alerts, workstream G).
 *
 * `planAlerts` is the pure decision layer: given the previous alert state and the newest
 * `RiskAssessment`, it says which categories deserve a notification right now and returns the
 * updated state to carry into the next tick. Nothing here touches `expo-notifications` — that is
 * `notify.test.ts`'s job — so every assertion is a plain object comparison.
 */

import { ALERT_COOLDOWN_MS, initialAlertState, planAlerts } from '@/alerts/plan';
import { assessment, MINUTE, T0 } from './fixtures';

describe('a level rising to amber or red', () => {
  it('notifies on green → amber', () => {
    const { intents } = planAlerts(initialAlertState(), assessment([{ level: 'amber' }]), T0);

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ category: 'respiratory', level: 'amber', critical: false });
  });

  it('notifies on the very first evaluation, straight to red', () => {
    // "Initial red" — there is no prior tick, so `initialAlertState()` starts every category at
    // green, and the first assessment's red reads as a rise exactly like any other.
    const { intents } = planAlerts(initialAlertState(), assessment([{ level: 'red' }]), T0);

    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ category: 'respiratory', level: 'red' });
  });

  it('notifies again on amber → red', () => {
    const first = planAlerts(initialAlertState(), assessment([{ level: 'amber' }]), T0);
    const second = planAlerts(first.state, assessment([{ level: 'red' }]), T0 + MINUTE);

    expect(second.intents).toHaveLength(1);
    expect(second.intents[0]).toMatchObject({ level: 'red' });
  });

  it('does not notify on green → green', () => {
    const { intents } = planAlerts(initialAlertState(), assessment([{ level: 'green' }]), T0);
    expect(intents).toHaveLength(0);
  });

  it('does not re-notify on the tick right after the rise, level unchanged', () => {
    const first = planAlerts(initialAlertState(), assessment([{ level: 'red' }]), T0);
    const second = planAlerts(first.state, assessment([{ level: 'red' }]), T0 + 1);

    expect(second.intents).toHaveLength(0);
  });
});

describe('falling levels', () => {
  it('never notifies on a fall', () => {
    const risen = planAlerts(initialAlertState(), assessment([{ level: 'red' }]), T0);
    const fallen = planAlerts(risen.state, assessment([{ level: 'amber' }]), T0 + MINUTE);
    const gone = planAlerts(fallen.state, assessment([{ level: 'green' }]), T0 + 2 * MINUTE);

    expect(fallen.intents).toHaveLength(0);
    expect(gone.intents).toHaveLength(0);
  });

  it('notifies again once the level rises after falling — no "stuck" suppression', () => {
    const risen = planAlerts(initialAlertState(), assessment([{ level: 'red' }]), T0);
    const fallen = planAlerts(risen.state, assessment([{ level: 'green' }]), T0 + MINUTE);
    const risenAgain = planAlerts(fallen.state, assessment([{ level: 'red' }]), T0 + 2 * MINUTE);

    expect(risenAgain.intents).toHaveLength(1);
    expect(risenAgain.intents[0]).toMatchObject({ level: 'red' });
  });
});

describe('the same-level cooldown', () => {
  it('is 30 minutes by default', () => {
    expect(ALERT_COOLDOWN_MS).toBe(30 * 60 * 1000);
  });

  it('does not re-notify a still-red category before the cooldown elapses', () => {
    const risen = planAlerts(initialAlertState(), assessment([{ level: 'red' }]), T0);
    const stillRed = planAlerts(
      risen.state,
      assessment([{ level: 'red' }]),
      T0 + ALERT_COOLDOWN_MS - 1,
    );

    expect(stillRed.intents).toHaveLength(0);
  });

  it('re-notifies a still-red category exactly at the cooldown boundary', () => {
    const risen = planAlerts(initialAlertState(), assessment([{ level: 'red' }]), T0);
    const stillRed = planAlerts(risen.state, assessment([{ level: 'red' }]), T0 + ALERT_COOLDOWN_MS);

    expect(stillRed.intents).toHaveLength(1);
    expect(stillRed.intents[0]).toMatchObject({ level: 'red' });
  });

  it('honours a custom cooldown passed through options', () => {
    const risen = planAlerts(initialAlertState(), assessment([{ level: 'amber' }]), T0);
    const early = planAlerts(risen.state, assessment([{ level: 'amber' }]), T0 + 999, {
      cooldownMs: 1000,
    });
    const onTime = planAlerts(risen.state, assessment([{ level: 'amber' }]), T0 + 1000, {
      cooldownMs: 1000,
    });

    expect(early.intents).toHaveLength(0);
    expect(onTime.intents).toHaveLength(1);
  });

  it('resets the cooldown clock on every repeat notification, not just the first', () => {
    const first = planAlerts(initialAlertState(), assessment([{ level: 'red' }]), T0);
    const repeat = planAlerts(
      first.state,
      assessment([{ level: 'red' }]),
      T0 + ALERT_COOLDOWN_MS,
    );
    const tooSoonAfterRepeat = planAlerts(
      repeat.state,
      assessment([{ level: 'red' }]),
      T0 + ALERT_COOLDOWN_MS + ALERT_COOLDOWN_MS - 1,
    );

    expect(repeat.intents).toHaveLength(1);
    expect(tooSoonAfterRepeat.intents).toHaveLength(0);
  });
});

describe('critical triggers', () => {
  it('notifies immediately when critical flips false → true, even at an unchanged level', () => {
    const first = planAlerts(
      initialAlertState(),
      assessment([{ level: 'red', critical: false }]),
      T0,
    );
    const criticalNow = planAlerts(
      first.state,
      assessment([{ level: 'red', critical: true }]),
      T0 + 1,
    );

    expect(criticalNow.intents).toHaveLength(1);
    expect(criticalNow.intents[0]).toMatchObject({ level: 'red', critical: true });
  });

  it('bypasses the cooldown — fires even right after a same-level notification', () => {
    const first = planAlerts(
      initialAlertState(),
      assessment([{ level: 'red', critical: false }]),
      T0,
    );
    // Well inside the 30-minute cooldown window.
    const critical = planAlerts(
      first.state,
      assessment([{ level: 'red', critical: true }]),
      T0 + MINUTE,
    );

    expect(critical.intents).toHaveLength(1);
  });

  it('does not re-fire on a later tick where critical stays true (no new flip)', () => {
    const first = planAlerts(
      initialAlertState(),
      assessment([{ level: 'red', critical: true }]),
      T0,
    );
    const stillCritical = planAlerts(
      first.state,
      assessment([{ level: 'red', critical: true }]),
      T0 + 1,
    );

    // No *new* flip and the same-level cooldown has not elapsed — silence, not spam.
    expect(stillCritical.intents).toHaveLength(0);
  });
});

describe('data quality', () => {
  it.each(['missing', 'stale'] as const)('never notifies while dataQuality is %s', (dataQuality) => {
    const { intents } = planAlerts(
      initialAlertState(),
      assessment([{ level: 'red', dataQuality }]),
      T0,
    );

    expect(intents).toHaveLength(0);
  });

  it('does not let a stale tick consume the rise — the real rise still notifies once data returns', () => {
    const stale = planAlerts(
      initialAlertState(),
      assessment([{ level: 'red', dataQuality: 'stale' }]),
      T0,
    );
    const fresh = planAlerts(stale.state, assessment([{ level: 'red', dataQuality: 'ok' }]), T0 + MINUTE);

    expect(stale.intents).toHaveLength(0);
    expect(fresh.intents).toHaveLength(1);
  });
});

describe('intent content', () => {
  it('titles a level-rise with the category label and a plain-language level word', () => {
    const { intents } = planAlerts(
      initialAlertState(),
      assessment([{ key: 'respiratory', level: 'red' }]),
      T0,
    );

    expect(intents[0].title).toBe('Respiratory risk: high');
  });

  it('titles an amber rise distinctly from a red one', () => {
    const { intents } = planAlerts(
      initialAlertState(),
      assessment([{ key: 'cardiovascular', level: 'amber' }]),
      T0,
    );

    expect(intents[0].title).toBe('Cardiovascular risk: elevated');
  });

  it('titles a critical fall trigger as an emergency, not a level readout', () => {
    const { intents } = planAlerts(
      initialAlertState(),
      assessment([{ key: 'fall', level: 'red', critical: true }]),
      T0,
    );

    expect(intents[0].title).toBe('Emergency: possible fall detected');
  });

  it('bodies the notification with the category guidance, first sentence only', () => {
    const { intents } = planAlerts(
      initialAlertState(),
      assessment([
        {
          level: 'red',
          guidance: 'Blood oxygen is critically low — get medical help now. Stay calm and seated.',
        },
      ]),
      T0,
    );

    expect(intents[0].body).toBe('Blood oxygen is critically low — get medical help now.');
  });

  it('stamps the intent with the assessment’s own evaluatedAt', () => {
    const { intents } = planAlerts(initialAlertState(), assessment([{ level: 'red' }], T0 + 42), T0 + 42);

    expect(intents[0].evaluatedAt).toBe(T0 + 42);
  });
});

describe('multiple categories in one tick', () => {
  it('emits one intent per category that qualifies, and none for the ones that do not', () => {
    const { intents } = planAlerts(
      initialAlertState(),
      assessment([
        { key: 'heat', level: 'amber' },
        { key: 'respiratory', level: 'green' },
        { key: 'cardiovascular', level: 'red' },
      ]),
      T0,
    );

    expect(intents.map((i) => i.category).sort()).toEqual(['cardiovascular', 'heat']);
  });
});

describe('initialAlertState', () => {
  it('starts every category at green, uncritical, and never notified', () => {
    const state = initialAlertState();

    for (const key of ['heat', 'respiratory', 'cardiovascular', 'fall', 'dehydration', 'fatigue'] as const) {
      expect(state.byCategory[key]).toEqual({
        level: 'green',
        critical: false,
        lastNotifiedAt: null,
        lastNotifiedLevel: null,
      });
    }
  });
});
