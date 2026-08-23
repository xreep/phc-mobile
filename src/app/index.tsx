import { Pressable, StyleSheet } from 'react-native';

import { RiskCard } from '@/components/risk-card';
import { Screen } from '@/components/screen';
import { SosAlert } from '@/components/sos-alert';
import { ThemedText } from '@/components/themed-text';
import { VitalsCard } from '@/components/vitals-card';
import { SENSOR_SOURCES } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useRiskAssessment } from '@/hooks/use-risk-assessment';
import { useSos } from '@/hooks/use-sos';
import type { SensorSource } from '@/risk';
import { formatAge } from '@/utils/format';

function sourceLabel(source: SensorSource): string {
  return SENSOR_SOURCES.find((option) => option.key === source)?.label ?? source;
}

export default function HomeScreen() {
  const { assessment, latest, baselines } = useRiskAssessment();

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
      {/* Both props come from the same `useRiskAssessment` memo, so the numbers and the
          averages they are compared against describe one evaluation (PRD §7.2.1 ext). */}
      <VitalsCard latest={latest} baselines={baselines} />

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
