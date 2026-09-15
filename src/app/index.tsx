import { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';

import { RiskCard } from '@/components/risk-card';
import { Screen } from '@/components/screen';
import { SensorFeedNotice } from '@/components/sensor-feed-notice';
import { SosAlert } from '@/components/sos-alert';
import { ThemedText } from '@/components/themed-text';
import { VitalsCard } from '@/components/vitals-card';
import { SENSOR_SOURCES } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useRiskAssessment } from '@/hooks/use-risk-assessment';
import { useSos } from '@/hooks/use-sos';
import { useRiskColors } from '@/hooks/use-theme';
import type { SensorSource } from '@/risk';
import { formatAge } from '@/utils/format';

function sourceLabel(source: SensorSource): string {
  return SENSOR_SOURCES.find((option) => option.key === source)?.label ?? source;
}

export default function HomeScreen() {
  // Dev-only demo control (rendered only under `__DEV__`, below). Arming it hands the risk
  // engine a window with a real impact-then-stillness sequence spliced into the tail — it does
  // not touch the SOS state directly. The fall is then detected by `rules/fall.ts` exactly as a
  // hardware accelerometer's would be, which is the whole point: the demo proves the detector,
  // not the card. Clearing it returns the window to normal, so the flow can be re-run after a
  // cancel or a send.
  const [simulateFall, setSimulateFall] = useState(false);
  const risk = useRiskColors();

  const { assessment, latest, baselines, live, feedStatus, feedFailure, requestAccess } =
    useRiskAssessment({ simulateFall });

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

      {/* Only ever visible with Health Connect selected and nothing usable on screen — says
          why, and offers the one fix a tap can make (PRD §7.2.4). */}
      <SensorFeedNotice
        live={live}
        status={feedStatus}
        failure={feedFailure}
        readingCount={assessment.sampleCount}
        onRequestAccess={requestAccess}
      />

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

      {/* Development builds only — `__DEV__` is false in a release bundle, so this control is
          absent from the APK's UI entirely. It exists so a fall can be *demonstrated*: see the
          comment on `simulateFall` above for why it injects a sensor reading rather than setting
          the card. */}
      {__DEV__ ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: simulateFall }}
          onPress={() => setSimulateFall((armed) => !armed)}
          style={({ pressed }) => [
            styles.devTool,
            {
              borderColor: simulateFall ? risk.red.fg : risk.neutral.fg,
              backgroundColor: simulateFall ? risk.red.bg : 'transparent',
            },
            pressed && styles.pressed,
          ]}>
          <ThemedText type="smallBold" style={{ color: simulateFall ? risk.red.fg : risk.neutral.fg }}>
            {simulateFall ? 'Clear simulated fall' : 'Dev · Simulate a fall'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" style={styles.devToolHint}>
            {simulateFall
              ? 'A 3.1 g impact followed by stillness is in the sensor window. The Fall Detection card and the SOS countdown above are the risk engine’s own response to it.'
              : 'Splices a real impact-then-stillness sequence into the sensor window so the fall rule fires and SOS escalates. Not present in release builds.'}
          </ThemedText>
        </Pressable>
      ) : null}
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
  /** Dashed outline so the control reads as instrumentation rather than a product affordance. */
  devTool: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.one,
    marginTop: Spacing.two,
  },
  devToolHint: {
    // Wraps under the label rather than beside it, so the explanation stays readable at the
    // narrow widths this sits at.
    flexShrink: 1,
  },
});
