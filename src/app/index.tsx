import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { RiskCard } from '@/components/risk-card';
import { Screen } from '@/components/screen';
import { SosAlert } from '@/components/sos-alert';
import { ThemedText } from '@/components/themed-text';
import { SENSOR_SOURCES } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useRiskAssessment } from '@/hooks/use-risk-assessment';
import { useSos } from '@/hooks/use-sos';
import type { SensorSource } from '@/risk';
import { formatAge } from '@/utils/format';

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

/** Placeholder for a vital the current reading does not carry. */
const ABSENT = '—';

function sourceLabel(source: SensorSource): string {
  return SENSOR_SOURCES.find((option) => option.key === source)?.label ?? source;
}

export default function HomeScreen() {
  const { assessment, latest } = useRiskAssessment();

  // The engine reports critical triggers and never acts; this is the one place that hands
  // them to the module that does (PRD §7.2.5). The countdown, consent gate, and delivery all
  // live behind `useSos` — the screen only supplies the assessment and renders the overlay.
  const sos = useSos({ assessment, latest });

  // Freshness comes from the timestamp the engine actually evaluated, not from a
  // hand-written string, so the header cannot claim the cards are more current than they
  // are.
  const subtitle =
    latest === null
      ? 'Waiting for the first reading'
      : `Updated ${formatAge(assessment.evaluatedAt - latest.timestamp)} · ${sourceLabel(latest.source)}`;

  return (
    <Screen title="Dashboard" subtitle={subtitle}>
      <Card>
        <ThemedText type="smallBold">Current vitals</ThemedText>
        <View style={styles.statsRow}>
          <Stat
            value={latest?.hr === undefined ? ABSENT : String(Math.round(latest.hr))}
            unit="bpm"
            label="Heart rate"
          />
          <Stat
            value={latest?.spo2 === undefined ? ABSENT : String(Math.round(latest.spo2))}
            unit="%"
            label="SpO₂"
          />
          <Stat
            value={latest?.skinTempC === undefined ? ABSENT : latest.skinTempC.toFixed(1)}
            unit="°C"
            label="Skin temp"
          />
        </View>
      </Card>

      <ThemedText type="smallBold">Risk overview</ThemedText>
      {/* Levels, colours, guidance, and metrics all come from the Tier-1 rule engine
          (PRD §7.2.2) evaluating the reading buffer — `CategoryAssessment` extends the
          `RiskCategory` shape `RiskCard` already renders, so the card is unchanged. */}
      {assessment.categories.map((category) => (
        <RiskCard key={category.key} category={category} />
      ))}

      <Pressable
        accessibilityRole="button"
        onPress={sos.press}
        style={({ pressed }) => [styles.sos, pressed && styles.pressed]}>
        <ThemedText style={styles.sosTitle}>Emergency SOS</ThemedText>
        <ThemedText type="small" style={styles.sosSubtitle}>
          {sos.contacts.length === 0
            ? 'Add an emergency contact in Settings so this has somewhere to send.'
            : `Alerts ${sos.contacts.length === 1 ? 'your contact' : `your ${sos.contacts.length} contacts`} with your location and status, after a 30-second cancel window.`}
        </ThemedText>
      </Pressable>

      <SosAlert controller={sos} />
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
