import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { RiskCard } from '@/components/risk-card';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { RISK_CATEGORIES, VITALS } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';

function Stat({ value, unit, label }: { value: string; unit: string; label: string }) {
  return (
    <View style={styles.stat}>
      <View style={styles.statValueRow}>
        <ThemedText style={styles.statValue}>{value}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {unit}
        </ThemedText>
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

export default function HomeScreen() {
  return (
    <Screen title="Dashboard" subtitle={`Updated ${VITALS.updatedAt} · Simulated data`}>
      <Card>
        <ThemedText type="smallBold">Current vitals</ThemedText>
        <View style={styles.statsRow}>
          <Stat value={String(VITALS.hr)} unit="bpm" label="Heart rate" />
          <Stat value={String(VITALS.spo2)} unit="%" label="SpO₂" />
          <Stat value={VITALS.skinTempC.toFixed(1)} unit="°C" label="Skin temp" />
        </View>
      </Card>

      <ThemedText type="smallBold">Risk overview</ThemedText>
      {RISK_CATEGORIES.map((category) => (
        <RiskCard key={category.key} category={category} />
      ))}

      <Pressable style={({ pressed }) => [styles.sos, pressed && styles.pressed]}>
        <ThemedText style={styles.sosTitle}>Emergency SOS</ThemedText>
        <ThemedText type="small" style={styles.sosSubtitle}>
          Sends your location and status to your emergency contacts.
        </ThemedText>
      </Pressable>
    </Screen>
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
  sos: {
    backgroundColor: '#C1121F',
    borderRadius: Spacing.four,
    paddingVertical: Spacing.four,
    paddingHorizontal: Spacing.four,
    alignItems: 'center',
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  sosTitle: {
    color: '#ffffff',
    fontSize: 24,
    lineHeight: 30,
    fontWeight: 700,
  },
  sosSubtitle: {
    color: '#ffffff',
    opacity: 0.9,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.8,
  },
});
