import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useRiskColors, useTheme } from '@/hooks/use-theme';
import {
  PREPAREDNESS_BADGE,
  PREPAREDNESS_DISCLAIMER,
  stepCount,
  type PreparednessAdvisory,
} from '@/advisories';

/**
 * One static preparedness advisory, rendered in the app's card language (PRD §4).
 *
 * ## Same visual family as `RiskCard`, deliberately not the same card
 * It reuses `Card`, the header row, the `smallBold` title, the pill, and the bulleted steps,
 * because a reader should not have to learn a second layout to read health guidance. Three things
 * are different, and each one is carrying a specific claim:
 *
 * - **The pill is always neutral and always reads "General advisory."** `RiskCard`'s pill is the
 *   verdict — green/amber/red plus a status word, derived from a score. There is no score here and
 *   no measurement to derive one from, so borrowing that pill would state a severity the content
 *   cannot support. Neutral is the same choice made for the environmental-context chip on
 *   `RiskCard`, and for the same reason: it is not a verdict.
 * - **The disclaimer is inside the card, under the title.** Not a footer, not a section note.
 *   These cards sit directly below the live heat and air-quality cards on the Environment screen,
 *   and the specific mistake to prevent is a reader carrying liveness across that boundary.
 * - **The steps are collapsed by default.** Twenty steps of fixed text above the fold would bury
 *   the live measurements that the screen is primarily for. Collapsed, the card still shows the
 *   title, the badge, the disclaimer, and the summary — everything needed to decide whether to
 *   open it — and the count on the toggle says how much is behind it.
 */
export function PreparednessCard({ advisory }: { advisory: PreparednessAdvisory }) {
  const [expanded, setExpanded] = useState(false);
  const risk = useRiskColors();
  const theme = useTheme();

  const steps = stepCount(advisory);

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <ThemedText type="smallBold">{advisory.title}</ThemedText>
        <View style={[styles.pill, { backgroundColor: risk.neutral.bg }]}>
          <ThemedText type="small" style={{ color: risk.neutral.fg }}>
            {PREPAREDNESS_BADGE}
          </ThemedText>
        </View>
      </View>

      {/* Above the summary, not below it: the qualification has to be read before the content it
          qualifies, or it is not doing anything. */}
      <ThemedText type="small" themeColor="textSecondary">
        {PREPAREDNESS_DISCLAIMER}
      </ThemedText>

      <ThemedText type="small" themeColor="textSecondary">
        {advisory.summary}
      </ThemedText>

      <Pressable
        onPress={() => setExpanded((open) => !open)}
        accessibilityRole="button"
        // The hazard is named in the label because two of these cards are on screen at once, so
        // "Show steps" alone would be two identically-labelled controls to a screen reader.
        accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${advisory.title.toLowerCase()} advisory steps`}
        accessibilityState={{ expanded }}
        style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}>
        <ThemedText type="small" themeColor="textSecondary">
          {expanded ? 'Hide steps' : `Show steps (${steps})`}
        </ThemedText>
      </Pressable>

      {expanded
        ? advisory.sections.map((section) => (
            <View key={section.heading} style={[styles.section, { borderTopColor: theme.background }]}>
              <ThemedText type="smallBold">{section.heading}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {section.risk}
              </ThemedText>
              <View style={styles.steps}>
                {section.steps.map((step) => (
                  // Bullet layout matches `RiskCard`'s actions list — a fixed-width bullet so
                  // wrapped text stays aligned under its own first line.
                  <View key={step} style={styles.step}>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.bullet}>
                      {'•'}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" style={styles.stepText}>
                      {step}
                    </ThemedText>
                  </View>
                ))}
              </View>
            </View>
          ))
        : null}
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
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.five,
  },
  toggle: {
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
  },
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
    gap: Spacing.one,
  },
  steps: {
    gap: Spacing.one,
  },
  step: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  bullet: {
    width: Spacing.two,
  },
  stepText: {
    flex: 1,
  },
});
