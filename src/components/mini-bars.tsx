import { StyleSheet, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Minimal bar-chart placeholder for the Trends screen. Bars are scaled to the
 * series' own min/max so the shape reads even for tight ranges (e.g. SpO₂).
 * Deliberately dependency-free — a real chart library can replace it later.
 */
export function MiniBars({ points, height = 56 }: { points: number[]; height?: number }) {
  const theme = useTheme();
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;

  return (
    <View style={[styles.container, { height }]}>
      {points.map((point, i) => {
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
