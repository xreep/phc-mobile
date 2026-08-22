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

/** Traffic-light risk indicator with one-line guidance (PRD §7.2.4 Home). */
export function RiskCard({ category }: { category: RiskCategory }) {
  const risk = useRiskColors();
  const c = risk[category.level];

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
