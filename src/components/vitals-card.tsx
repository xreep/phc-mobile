/**
 * Current vitals, each shown beside its own rolling average over the same window
 * (PRD §7.2.1 extension).
 *
 * ## Why this is its own file
 * It used to be twenty lines inside `app/index.tsx` with three hardcoded labels. It moved out
 * for a reason that is really a testing reason: the shipped demo window is a *quiet* fixture —
 * its newest heart rate sits 0.2 bpm off the window mean — so nothing rendered from it can
 * demonstrate that a deviation reaches the screen at all. A component that takes `baselines`
 * as a prop can be handed a rising series, a falling one, a pending one, and an empty one, and
 * asserted on each. Rendered only through the real hook, three of those four states would be
 * unreachable and the row could be wired to a constant without a single test noticing.
 *
 * ## What the three columns are derived from
 * Everything — order, labels, units, the big number, and the delta line — comes from
 * `baselines.vitals`, which `src/risk/baseline.ts` builds from the readings.
 *
 * The big number is deliberately the vital's `current` and not `latest[field]`, even though the
 * two are the same reading whenever the sensor is behaving. They diverge when the newest reading
 * fails the plausibility gate, and that is the case worth getting right: a 400 bpm artifact
 * rendered in 28-point type over "in line with your 10-minute average" reads as an endorsement of
 * a number the engine has already refused. Showing the newest *usable* reading instead keeps the
 * number and the sentence under it describing one moment, which is the whole point of the pairing.
 *
 * `latest` survives as the fallback for the case where nothing in the window is usable — a sensor
 * stuck at 400 shows its 400 with a `—` delta and a summary saying the readings were unusable,
 * because a blank column would suggest a sensor that reported nothing at all. Different problem,
 * different display.
 *
 * ## Why a deviation is not colour-coded
 * The traffic-light palette belongs to the rule engine, and a deviation from a ten-minute
 * average is not a risk judgement — a 15 % rise is a normal response to standing up. Emphasis
 * here is weight only. Anything that needs a colour is a rule, and rules get cards.
 */

import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { BaselineDelta, SensorReading, VitalBaselines, VitalField } from '@/risk';

/** Placeholder for a vital the current reading does not carry. */
const ABSENT = '—';

/** Skin temperature is the only vital fine-grained enough to warrant a decimal place. */
function formatValue(
  field: VitalField,
  current: number | null,
  latest: SensorReading | null,
): string {
  // `current` first: it is the newest reading the engine accepted, so it and the delta line
  // below it always describe the same moment. `latest` only answers when the engine accepted
  // nothing — see the file header.
  const value = current ?? latest?.[field];
  if (value === undefined) return ABSENT;
  return field === 'skinTempC' ? value.toFixed(1) : String(Math.round(value));
}

function Stat({ latest, vital }: { latest: SensorReading | null; vital: BaselineDelta }) {
  return (
    <View style={styles.stat}>
      <View style={styles.statValueRow}>
        <ThemedText style={styles.statValue}>
          {formatValue(vital.field, vital.current, latest)}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {vital.unit}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {vital.label}
      </ThemedText>
      {/* `short` is four characters wide by design; the sentence a screen reader needs is on
          the label, because "plus fifteen percent" on its own says nothing about what of. */}
      <ThemedText
        type={vital.meaningful ? 'smallBold' : 'small'}
        themeColor={vital.meaningful ? 'text' : 'textSecondary'}
        accessibilityLabel={vital.summary}>
        {vital.short}
      </ThemedText>
    </View>
  );
}

export function VitalsCard({
  latest,
  baselines,
}: {
  readonly latest: SensorReading | null;
  readonly baselines: VitalBaselines;
}) {
  return (
    <Card>
      <ThemedText type="smallBold">Current vitals</ThemedText>
      <View style={styles.statsRow}>
        {baselines.vitals.map((vital) => (
          <Stat key={vital.field} latest={latest} vital={vital} />
        ))}
      </View>
      {/* One sentence, naming its own horizon — "your 10-minute average" — because the
          dehydration and fatigue cards below look back 15 and 18 minutes with their own
          baselines, and an unqualified "your recent average" would read as a contradiction
          when they disagree. */}
      <ThemedText type="small" themeColor="textSecondary">
        {baselines.headline}
      </ThemedText>
    </Card>
  );
}

const styles = StyleSheet.create({
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  stat: {
    gap: Spacing.half,
  },
  statValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: Spacing.one,
  },
  statValue: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: 700,
  },
});
