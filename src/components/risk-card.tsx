import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import type { RiskCategory, RiskLevel } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useRiskColors } from '@/hooks/use-theme';

/** Plain-language status word for each traffic-light level (color shown by the dot). */
const LEVEL_LABEL: Record<RiskLevel, string> = {
  green: 'Normal',
  amber: 'Caution',
  red: 'Alert',
};

/**
 * Traffic-light risk indicator with tiered guidance (PRD §7.2.4 Home).
 *
 * The tier word itself is deliberately not shown. `category.tier` is how the engine chose the
 * headline and the steps; putting "moderate" on the card would ask the reader to reconcile two
 * severity vocabularies at once — mild/moderate/severe against Normal/Caution/Alert — for no
 * information they cannot already read off the sentence.
 */
export function RiskCard({ category }: { category: RiskCategory }) {
  const risk = useRiskColors();
  const c = risk[category.level];
  // Empty exactly when no rung was selected, which is the steady-state card. Optional on
  // `RiskCategory` so hand-built fixtures need not invent one.
  const actions = category.actions ?? [];

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <ThemedText type="smallBold">{category.label}</ThemedText>
        <View style={[styles.pill, { backgroundColor: c.bg }]}>
          <View style={[styles.dot, { backgroundColor: c.fg }]} />
          <ThemedText type="small" style={{ color: c.fg }}>
            {LEVEL_LABEL[category.level]}
          </ThemedText>
        </View>
      </View>

      <ThemedText type="small" themeColor="textSecondary">
        {category.guidance}
      </ThemedText>

      {actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((action) => (
            <View key={action} style={styles.action}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.bullet}>
                {'•'}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.actionText}>
                {action}
              </ThemedText>
            </View>
          ))}
        </View>
      ) : null}

      {category.metric ? (
        <ThemedText type="code" themeColor="textSecondary">
          {category.metric}
        </ThemedText>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  actions: {
    gap: Spacing.one,
  },
  action: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  bullet: {
    // Fixed width so wrapped step text stays aligned under its own first line rather than
    // running back under the bullet.
    width: Spacing.two,
  },
  actionText: {
    flex: 1,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.five,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
