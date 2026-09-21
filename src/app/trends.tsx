import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { MiniBars } from '@/components/mini-bars';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import type { TrendRange } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useTrends } from '@/hooks/use-trends';
import type { VitalField } from '@/risk';
import { useSettings } from '@/settings/provider';
import { HISTORY_RETAIN_MS } from '@/store';
import type { TrendSummary } from '@/trends/aggregate';

const RANGES: { key: TrendRange; label: string }[] = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
];

const FIELD_LABELS: Record<VitalField, string> = {
  hr: 'Heart Rate',
  spo2: 'Blood Oxygen',
  skinTempC: 'Skin Temperature',
};

const EMPTY_TEXT: Record<TrendRange, string> = {
  '24h': 'No readings in the last 24 hours yet',
  '7d': 'No readings in the last 7 days yet',
};

/** Whole numbers for hr/spo2 (as the vitals row does), one decimal for skin temperature —
 *  the same rounding convention `risk/config.ts`'s `repairBaseline` documents for the row
 *  beside this one, so the two never disagree about how many digits a vital deserves. */
function formatValue(field: VitalField, value: number): string {
  return field === 'skinTempC' ? value.toFixed(1) : String(Math.round(value));
}

const RETAIN_DAYS = Math.round(HISTORY_RETAIN_MS / (24 * 60 * 60 * 1000));

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
 * Why this notice is not optional.
 *
 * `src/store/types.ts`'s second rule: simulated readings are never written, because the hook
 * only appends while polling Health Connect. So a chart drawn while the simulated source is
 * selected would either be empty (confusing, since the vitals row elsewhere on this build shows
 * numbers) or — worse — would show *leftover* history from an earlier Health Connect session,
 * which a reader would reasonably take for live simulated data. Telling them to switch sources
 * is the actionable fix; showing a chart that may or may not be current is not.
 */
function SimulatedSourceNotice() {
  return (
    <Card>
      <ThemedText type="smallBold">Trends need recorded readings</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Switch Sensor source to Android Health Connect in Settings. Simulated readings are never
        stored.
      </ThemedText>
    </Card>
  );
}

function UnavailableNotice() {
  return (
    <Card>
      <ThemedText type="smallBold">History may not survive a restart</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        This phone could not open its on-device database, so recent readings are being kept in
        memory for this session only — closing the app may lose them.
      </ThemedText>
    </Card>
  );
}

function EmptyNotice({ range }: { range: TrendRange }) {
  return (
    <Card>
      <ThemedText type="small" themeColor="textSecondary">
        {EMPTY_TEXT[range]}
      </ThemedText>
    </Card>
  );
}

function LoadingNotice() {
  return (
    <Card>
      <ThemedText type="small" themeColor="textSecondary">
        Loading trends…
      </ThemedText>
    </Card>
  );
}

function TrendCard({ series }: { series: TrendSummary }) {
  return (
    <Card>
      <View style={styles.cardHeader}>
        <ThemedText type="smallBold">{FIELD_LABELS[series.field]}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {formatValue(series.field, series.current)} {series.unit}
        </ThemedText>
      </View>
      <MiniBars points={series.points} />
      <View style={styles.statsRow}>
        <Stat label="Min" value={`${formatValue(series.field, series.min)} ${series.unit}`} />
        <Stat label="Avg" value={`${formatValue(series.field, series.avg)} ${series.unit}`} />
        <Stat label="Max" value={`${formatValue(series.field, series.max)} ${series.unit}`} />
      </View>
    </Card>
  );
}

export default function TrendsScreen() {
  const [range, setRange] = useState<TrendRange>('24h');
  const { settings } = useSettings();
  const { series, status } = useTrends(range);

  const simulated = settings.sensorSource === 'simulated';

  return (
    <Screen title="Trends" subtitle="Your recorded vitals history">
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

      {simulated ? (
        <SimulatedSourceNotice />
      ) : status === 'unavailable' ? (
        <UnavailableNotice />
      ) : status === 'loading' ? (
        <LoadingNotice />
      ) : status === 'empty' ? (
        <EmptyNotice range={range} />
      ) : (
        series.map((s) => <TrendCard key={s.field} series={s} />)
      )}

      <ThemedText type="small" themeColor="textSecondary" style={styles.footer}>
        Stored on this phone only · last {RETAIN_DAYS} days
      </ThemedText>
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
  footer: {
    textAlign: 'center',
    paddingTop: Spacing.two,
  },
});
