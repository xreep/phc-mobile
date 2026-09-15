import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { MiniBars } from '@/components/mini-bars';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { TRENDS, type TrendRange } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';

const RANGES: { key: TrendRange; label: string }[] = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
];

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
    </View>
  );
}

/**
 * Why this banner is not optional.
 *
 * The series below come from the `TRENDS` constant in `health-data.ts` — fixed example curves,
 * not a recorded history. PRD §7.2.1 vitals ingestion has not landed, so there is no buffer to
 * read from and nothing is written to disk: the only AsyncStorage keys this app owns are the
 * settings blob and the last-known-good weather reading. The previous subtitle ("Vitals history
 * from on-device storage") therefore asserted a persistence layer that does not exist. The
 * Community screen already states this principle for its placeholder cohort; the same disclosure
 * belongs here, because a chart that looks like real history is exactly the thing a viewer will
 * assume is real history unless told otherwise.
 */
function SampleDataBanner() {
  return (
    <Card>
      <ThemedText type="smallBold">Example data — not a recorded history</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        These curves are fixed sample series to show how trends will look. This build does not yet
        record or store your vitals over time, so nothing here reflects your own readings.
      </ThemedText>
    </Card>
  );
}

export default function TrendsScreen() {
  const [range, setRange] = useState<TrendRange>('24h');

  return (
    <Screen title="Trends" subtitle="Example series · concept demo">
      <SampleDataBanner />

      <ThemedView type="backgroundElement" style={styles.segment}>
        {RANGES.map((r) => {
          const active = r.key === range;
          return (
            <Pressable key={r.key} onPress={() => setRange(r.key)} style={styles.segmentItemWrap}>
              <ThemedView
                type={active ? 'backgroundSelected' : 'backgroundElement'}
                style={styles.segmentItem}>
                <ThemedText type="small" themeColor={active ? 'text' : 'textSecondary'}>
                  {r.label}
                </ThemedText>
              </ThemedView>
            </Pressable>
          );
        })}
      </ThemedView>

      {TRENDS[range].map((series) => (
        <Card key={series.key}>
          <View style={styles.cardHeader}>
            <ThemedText type="smallBold">{series.label}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {series.current} {series.unit}
            </ThemedText>
          </View>
          <MiniBars points={series.points} />
          <View style={styles.statsRow}>
            <Stat label="Min" value={`${series.min} ${series.unit}`} />
            <Stat label="Avg" value={`${series.avg} ${series.unit}`} />
            <Stat label="Max" value={`${series.max} ${series.unit}`} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    padding: Spacing.half,
    borderRadius: Spacing.three,
    gap: Spacing.half,
  },
  segmentItemWrap: {
    flex: 1,
  },
  segmentItem: {
    paddingVertical: Spacing.two,
    alignItems: 'center',
    borderRadius: Spacing.two,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  stat: {
    gap: Spacing.half,
  },
});
