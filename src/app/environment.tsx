import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { ENVIRONMENT, type RiskLevel } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useRiskColors } from '@/hooks/use-theme';

function LevelChip({ label, level }: { label: string; level: RiskLevel }) {
  const c = useRiskColors()[level];
  return (
    <View style={[styles.chip, { backgroundColor: c.bg }]}>
      <ThemedText type="small" style={{ color: c.fg }}>
        {label}
      </ThemedText>
    </View>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.metric}>
      <ThemedText type="subtitle">{value}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

export default function EnvironmentScreen() {
  const env = ENVIRONMENT;

  return (
    <Screen title="Environment" subtitle={`${env.location} · Updated ${env.updatedAt}`}>
      <Card>
        <View style={styles.cardHeader}>
          <ThemedText type="smallBold">Weather</ThemedText>
          <LevelChip label={`Heat: ${env.heatIndexBand.label}`} level={env.heatIndexBand.level} />
        </View>
        <View style={styles.metricsRow}>
          <Metric value={`${env.tempC}°C`} label="Temperature" />
          <Metric value={`${env.humidity}%`} label="Humidity" />
          <Metric value={`${env.heatIndexC}°C`} label="Heat index" />
        </View>
      </Card>

      <Card>
        <View style={styles.cardHeader}>
          <ThemedText type="smallBold">Air Quality</ThemedText>
          <LevelChip label={env.aqiCategory.label} level={env.aqiCategory.level} />
        </View>
        <View style={styles.metricsRow}>
          <Metric value={String(env.aqi)} label="AQI (US)" />
        </View>
      </Card>

      <ThemedText type="smallBold">Active advisories</ThemedText>
      {env.advisories.map((advisory) => (
        <Card key={advisory.id}>
          <View style={styles.cardHeader}>
            <ThemedText type="smallBold">{advisory.title}</ThemedText>
            <LevelChip label={advisory.source} level={advisory.level} />
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {advisory.detail}
          </ThemedText>
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  chip: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.five,
  },
  metricsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  metric: {
    gap: Spacing.half,
  },
});
