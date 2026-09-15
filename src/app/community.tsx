/**
 * Community View — a concept demonstration of opt-in anonymized area reporting (PRD §4, ASHA
 * persona).
 *
 * ## What this screen is
 * PRD §4's ASHA worker serves a ward, not a person, and the question they arrive with is which
 * households need visiting today. This screen shows the shape of an answer: counts of nearby
 * participants at elevated risk, per category, with small counts withheld.
 *
 * ## What this screen is not
 * There is no server, no peer discovery, and no network call on this route. The figures come
 * from {@link demoReports} — a fixed cohort of fourteen participants who do not exist,
 * constructed locally on every render. Nothing is uploaded when the toggle is on, and the user's
 * own reading is not in the cohort.
 *
 * That is stated on the screen itself, in a banner that cannot be dismissed, and it is stated
 * first. `environment.tsx` sets the standard this has to meet — "There is no fallback demo data:
 * when there is nothing to show, the screen says so rather than filling in plausible values" —
 * and this screen is the one place in the app that does show invented figures. The only way to
 * do that without violating the doctrine is to make the invention the most prominent thing
 * about it. A "Demo" pill in a corner would not be enough: the numbers here are exactly as
 * plausible as the real ones two tabs over.
 *
 * ## Why the toggle is still honoured
 * Gating a screen that sends nothing looks like ceremony, and it is the opposite. The consent
 * gate is the part of a community feature that a real deployment would get wrong, so the demo
 * exercises the real pref (`anon_aggregate`, off by default) through the real predicate
 * (`isCommunityInsightsEnabled`), and shows **no figures at all** while it is off — not greyed
 * out, not blurred, absent. A prototype that renders the aggregate first and asks afterwards
 * teaches the wrong default to whoever builds the real one.
 */

import { StyleSheet, Switch, View } from 'react-native';

import { Card } from '@/components/card';
import { Screen } from '@/components/screen';
import { SettingRow } from '@/components/setting-row';
import { ThemedText } from '@/components/themed-text';
import {
  DATA_SHARING_PREFS,
  type DataSharingPref,
  type RiskLevel,
} from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import {
  DEMO_AREA,
  demoReports,
  publishedTallies,
  summarizeCommunity,
  withheldTallies,
  type CategoryTally,
  type CommunitySummary,
} from '@/community';
import { useNow } from '@/hooks/use-now';
import { useRiskColors } from '@/hooks/use-theme';
import { formatWindowLabel } from '@/risk';
import { useSettings } from '@/settings/provider';
import { isCommunityInsightsEnabled } from '@/settings/store';

/** What a withheld count renders as. Matches the Dashboard's placeholder for an absent value,
 *  because to a reader the two are the same statement: this figure is not available to you. */
const WITHHELD = '—';

/** Cohort timestamps are relative to `now`, so a tick keeps the window description true rather
 *  than changing any figure — see `demo-cohort.ts`. Matches the Environment screen's cadence. */
const AGE_TICK_MS = 30 * 1000;

/**
 * The pref this screen is gated on.
 *
 * Looked up rather than re-worded, so the switch here and the one in Settings cannot end up
 * describing different promises. The `??` is a render guard for a pref removed from the list
 * without the type changing — not an expected path.
 */
const COMMUNITY_PREF: DataSharingPref = DATA_SHARING_PREFS.find(
  (pref) => pref.key === 'anon_aggregate',
) ?? {
  key: 'anon_aggregate',
  label: 'Anonymous community insights',
  description: 'Share coarse, de-identified risk trends with local responders.',
  defaultOn: false,
};

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

/**
 * One category row.
 *
 * A withheld row shows no count and no chip. Both omissions are the point — see
 * {@link CategoryTally}, where a level published beside a withheld count is the disclosure the
 * suppression exists to prevent.
 */
function TallyRow({ tally }: { tally: CategoryTally }) {
  return (
    <View style={styles.tallyRow}>
      <ThemedText type="small" style={styles.tallyLabel}>
        {tally.label}
      </ThemedText>
      {tally.count === null || tally.level === null ? (
        <ThemedText type="small" themeColor="textSecondary">
          {WITHHELD}
        </ThemedText>
      ) : (
        <LevelChip label={`${tally.count}`} level={tally.level} />
      )}
    </View>
  );
}

/** The banner. First child of the screen in both states, and never conditional. */
function ConceptDemoBanner() {
  return (
    <Card>
      <ThemedText type="smallBold">Concept demonstration — not live data</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        This build has no community server and no way to send or receive a report. The figures
        below describe 14 placeholder participants generated on this device; they are not real
        people, and your own readings are not among them.
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Nothing is shared whether the switch is on or off. What the switch demonstrates is the
        consent check a real version would have to pass before publishing anything.
      </ThemedText>
    </Card>
  );
}

/** The opt-in control, shown in both states so turning it back off is as easy as turning it on. */
function ConsentRow({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <SettingRow title={COMMUNITY_PREF.label} description={COMMUNITY_PREF.description}>
      <Switch value={enabled} onValueChange={onChange} accessibilityLabel={COMMUNITY_PREF.label} />
    </SettingRow>
  );
}

function SummaryCards({ summary }: { summary: CommunitySummary }) {
  const published = publishedTallies(summary);
  const withheld = withheldTallies(summary);
  const windowLabel = formatWindowLabel(summary.windowMs);

  return (
    <>
      <Card>
        <ThemedText type="smallBold">Ward summary</ThemedText>
        <ThemedText type="subtitle">
          {summary.headline ?? 'Nothing to report at this size of group.'}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {summary.participants === null
            ? `Too few participants in the past ${windowLabel} window to report anything at all.`
            : `${summary.participants} participants shared a reading in the past ${windowLabel} window.`}
        </ThemedText>
      </Card>

      <ThemedText type="smallBold">By category</ThemedText>
      <Card>
        {summary.tallies.map((tally) => (
          <TallyRow key={tally.category} tally={tally} />
        ))}
      </Card>

      {/* The explanation is not a footnote. A reader who does not know the threshold cannot
          tell a withheld row from a zero, which would make every `—` read as "all clear". */}
      <Card>
        <ThemedText type="smallBold">Why some rows show {WITHHELD}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {`A count is only shown once at least ${summary.suppressionThreshold} participants are in it. ` +
            `${published.length} of ${summary.tallies.length} categories reach that here; the other ${withheld.length} show ${WITHHELD}.`}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {`A withheld row could be 0, 1, or ${summary.suppressionThreshold - 1} — it does not say which, and it does not say how serious. ` +
            'In a ward this small, "1 person at elevated risk" would often be enough to name them.'}
        </ThemedText>
      </Card>
    </>
  );
}

export default function CommunityScreen() {
  const { settings, setSharing } = useSettings();

  // One clock read per render, as on the Environment screen. The cohort is stamped against it,
  // so every report and the window that filters them share a single instant.
  const now = useNow(AGE_TICK_MS);

  const enabled = isCommunityInsightsEnabled(settings);

  // Computed only when opted in. Not merely hidden — while the switch is off there is no
  // aggregate in memory to leak into a log, a snapshot, or a later refactor that moves the
  // conditional up one level and forgets what it was for.
  const summary = enabled
    ? summarizeCommunity(demoReports(now), { now, area: DEMO_AREA })
    : null;

  return (
    <Screen title="Community" subtitle={`${DEMO_AREA} · concept demo`}>
      <ConceptDemoBanner />

      {summary === null ? (
        <>
          <Card>
            <ThemedText type="smallBold">Community insights are off</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Nothing about your ward is shown while this is off — not a count, not a total, not a
              category. Turn it on to see what the aggregate would look like.
            </ThemedText>
            <ConsentRow enabled={false} onChange={(value) => setSharing('anon_aggregate', value)} />
          </Card>
          <ThemedText type="small" themeColor="textSecondary">
            This is the same switch as “{COMMUNITY_PREF.label}” under Settings → Data sharing.
          </ThemedText>
        </>
      ) : (
        <>
          <SummaryCards summary={summary} />
          <Card>
            <ConsentRow enabled onChange={(value) => setSharing('anon_aggregate', value)} />
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Spacing.five,
  },
  tallyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
  },
  tallyLabel: {
    flex: 1,
  },
});
