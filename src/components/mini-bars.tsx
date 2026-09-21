import { StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Minimal bar-chart placeholder for the Trends screen. Bars are scaled to the
 * series' own min/max so the shape reads even for tight ranges (e.g. SpO₂).
 * Deliberately dependency-free — a real chart library can replace it later.
 *
 * A `null` point (a bucket with no reading — `src/trends/aggregate.ts`) renders as an empty
 * slot, not a zero-height bar: a real trend has holes, and a zero bar would claim a measured
 * zero, which for heart rate or SpO₂ is a false and alarming reading rather than an absent one.
 */
export function MiniBars({
  points,
  height = 56,
}: {
  points: readonly (number | null)[];
  height?: number;
}) {
  const theme = useTheme();
  const numeric = points.filter((point): point is number => point !== null);
  const max = numeric.length > 0 ? Math.max(...numeric) : 0;
  const min = numeric.length > 0 ? Math.min(...numeric) : 0;
  const range = max - min || 1;

  return (
    <View style={[styles.container, { height }]}>
      {points.map((point, i) => {
        if (point === null) return <View key={i} style={styles.slot} />;
        const ratio = (point - min) / range;
        const barHeight = Math.max(4, ratio * height);
        return (
          <View key={i} style={styles.slot}>
            <View style={[styles.bar, { height: barHeight, backgroundColor: theme.text }]} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.half,
  },
  slot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  bar: {
    width: '100%',
    borderRadius: 3,
    opacity: 0.75,
  },
});
