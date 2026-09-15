import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import type { RiskCategory, RiskLevel } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useRiskColors, useTheme } from '@/hooks/use-theme';
import { environmentalContextFor, ENV_CONTEXT_LABEL } from '@/risk';

/** Plain-language status word for each traffic-light level (color shown by the dot). */
const LEVEL_LABEL: Record<RiskLevel, string> = {
  green: 'Normal',
  amber: 'Caution',
  red: 'Alert',
};

/**
 * Traffic-light risk indicator with tiered guidance (PRD §7.2.4 Home).
 *
 * The tier word itself is deliberately not shown. `category.tier` is how the engine chose the
 * headline and the steps; putting "moderate" on the card would ask the reader to reconcile two
 * severity vocabularies at once — mild/moderate/severe against Normal/Caution/Alert — for no
 * information they cannot already read off the sentence.
 *
 * The environmental block at the foot is the opposite case: a number the engine *does* compute
 * and does not apply. See `EnvContext` below.
 */
export function RiskCard({
  category,
}: {
  /**
   * `envMultiplier` is spelled out here rather than left implicit.
   *
   * The Dashboard passes `CategoryAssessment`, which carries it; hand-built `RiskCategory`
   * fixtures do not, which is why it is optional. Declaring it on the prop keeps the intersection
   * that `risk/types.ts` calls load-bearing (a `CategoryAssessment` is still assignable, and so
   * is a bare `RiskCategory`) while making the environmental block's one input visible to anyone
   * reading this signature — otherwise it looks like a read of a field the type does not have,
   * which is exactly the shape of thing a later cleanup deletes as dead.
   */
  category: RiskCategory & { readonly envMultiplier?: number };
}) {
  const risk = useRiskColors();
  const theme = useTheme();
  const c = risk[category.level];
  // Empty exactly when no rung was selected, which is the steady-state card. Optional on
  // `RiskCategory` so hand-built fixtures need not invent one.
  const actions = category.actions ?? [];
  // `null` for a plain `RiskCategory` (no `envMultiplier` field) and for every category with
  // no environmental input, so the block is absent from fixtures and from four of the six
  // cards rather than rendering an empty shell. No cast needed: `envMultiplier` is optional on
  // the parameter, so a bare `RiskCategory` satisfies it and a `CategoryAssessment` carries it.
  const env = environmentalContextFor(category);

  return (
    <Card style={styles.card}>
      <View style={styles.row}>
        <ThemedText type="smallBold">{category.label}</ThemedText>
        <View style={[styles.pill, { backgroundColor: c.bg }]}>
          <View style={[styles.dot, { backgroundColor: c.fg }]} />
          <ThemedText type="small" style={{ color: c.fg }}>
            {LEVEL_LABEL[category.level]}
          </ThemedText>
        </View>
      </View>

      <ThemedText type="small" themeColor="textSecondary">
        {category.guidance}
      </ThemedText>

      {actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((action) => (
            <View key={action} style={styles.action}>
              <ThemedText type="small" themeColor="textSecondary" style={styles.bullet}>
                {'•'}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.actionText}>
                {action}
              </ThemedText>
            </View>
          ))}
        </View>
      ) : null}

      {category.metric ? (
        <ThemedText type="code" themeColor="textSecondary">
          {category.metric}
        </ThemedText>
      ) : null}

      {env === null ? null : (
        // Divided off from the verdict above it, because that is exactly the relationship:
        // everything above comes from the body, this comes from the air.
        <View style={[styles.env, { borderTopColor: theme.background }]}>
          <View style={styles.row}>
            <ThemedText type="small" themeColor="textSecondary">
              {ENV_CONTEXT_LABEL}
            </ThemedText>
            {/* Neutral, never the category's level colour. A red chip here would read as a
                second verdict; this is the one number on the card that is not one. */}
            <View style={[styles.pill, { backgroundColor: risk.neutral.bg }]}>
              <ThemedText type="small" style={{ color: risk.neutral.fg }}>
                {`${env.factor} +${env.percent}%`}
              </ThemedText>
            </View>
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {env.detail}
          </ThemedText>
          {/* Travels with the number from the engine — see `env-context.ts` for why it is
              not the card's sentence to write or to omit. */}
          <ThemedText type="small" themeColor="textSecondary">
            {env.disclaimer}
          </ThemedText>
        </View>
      )}
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
  actions: {
    gap: Spacing.one,
  },
  action: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  bullet: {
    // Fixed width so wrapped step text stays aligned under its own first line rather than
    // running back under the bullet.
    width: Spacing.two,
  },
  actionText: {
    flex: 1,
  },
  env: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.two,
    gap: Spacing.one,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.five,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
