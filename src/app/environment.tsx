/**
 * Live local weather, air quality, and derived advisories (PRD §7.2.3 / §7.2.4).
 *
 * Every number on this screen comes from OpenWeatherMap, fetched for the device's coarse
 * location. There is no fallback demo data: when there is nothing to show, the screen says
 * so rather than filling in plausible values, because a health app that invents a
 * comfortable heat index is worse than one that admits it has no reading.
 *
 * ## What the header has to be honest about
 * Three separate things can be true at once and each changes how much the reading is worth,
 * so each is surfaced rather than averaged into a single "updated" line:
 *
 * - **Whose location this is** — a device fix, or the fallback city because permission was
 *   denied. Presenting another city's heat warning as local is a meaningful
 *   misrepresentation, not a cosmetic one.
 * - **How old the observation is** — from the provider's own timestamp, not from when the
 *   app happened to render.
 * - **Whether it came from the network or from disk** — a cached reading is still useful
 *   offline, but the user should know that is what they are looking at.
 */

import { Pressable, StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import type { RiskLevel } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useEnvironmentFeed } from '@/environment/provider';
import type { LocationFallbackReason } from '@/environment';
import { useNow } from '@/hooks/use-now';
import { useRiskColors } from '@/hooks/use-theme';
import { formatAge } from '@/utils/format';

/** Placeholder for a value this observation does not carry. Matches the Dashboard's. */
const ABSENT = '—';

/**
 * How often the two "updated N ago" labels advance.
 *
 * Half of `formatAge`'s seconds-to-minutes boundary, so a freshly fetched observation is
 * never described in seconds that are more than a tick out of date. Finer than that would
 * only re-render text that has not changed.
 */
const AGE_TICK_MS = 30 * 1000;

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

/** Plain-language reason, so a denied permission is actionable rather than mysterious. */
const FALLBACK_REASON_TEXT: Readonly<Record<LocationFallbackReason, string>> = {
  permission_denied: 'location permission not granted',
  services_disabled: 'location services are off',
  unavailable: 'location unavailable',
  timeout: 'location took too long',
};

export default function EnvironmentScreen() {
  const { environment, status, failure, refreshing, refresh } = useEnvironmentFeed();

  // One clock read per render rather than one per formatted field, so the two ages on screen
  // cannot be computed against instants a few milliseconds apart and disagree. It ticks,
  // because an observation age that only advances when the data does would keep claiming the
  // reading is two minutes old for the whole 30 minutes until the next refresh.
  const now = useNow(AGE_TICK_MS);

  const subtitle = (() => {
    if (environment === null) {
      return status === 'loading' ? 'Finding your location…' : 'No environment data yet';
    }
    const where =
      environment.locationSource === 'fallback'
        ? `${environment.location} (default — ${
            FALLBACK_REASON_TEXT[environment.locationFallbackReason ?? 'unavailable']
          })`
        : environment.location;
    return `${where} · Updated ${formatAge(now - environment.observedAt)}`;
  })();

  return (
    <Screen
      title="Environment"
      subtitle={subtitle}
      headerAccessory={
        <Pressable
          onPress={refresh}
          disabled={refreshing}
          accessibilityRole="button"
          accessibilityLabel="Refresh environment data"
          accessibilityState={{ disabled: refreshing }}
          style={({ pressed }) => [styles.refresh, (pressed || refreshing) && styles.pressed]}>
          <ThemedText type="small" themeColor="textSecondary">
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </ThemedText>
        </Pressable>
      }>
      {/* Shown alongside the data rather than instead of it: a stale reading plus a note is
          more useful offline than an empty screen, but it must not pass for a live one. */}
      {status === 'cached' && environment !== null ? (
        <Card>
          <ThemedText type="smallBold">Showing the last saved reading</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {`Could not reach the weather service, so this is the reading saved ${formatAge(
              now - environment.fetchedAt,
            )}.`}
          </ThemedText>
        </Card>
      ) : null}

      {status === 'error' ? (
        <Card>
          <ThemedText type="smallBold">Environment data unavailable</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {failure?.message ?? 'Could not load weather or air quality.'}
          </ThemedText>
        </Card>
      ) : null}

      {environment === null ? null : (
        <>
          <Card>
            <View style={styles.cardHeader}>
              <ThemedText type="smallBold">Weather</ThemedText>
              {environment.heatIndexBand === null ? null : (
                <LevelChip
                  label={`Heat: ${environment.heatIndexBand.label}`}
                  level={environment.heatIndexBand.level}
                />
              )}
            </View>
            <View style={styles.metricsRow}>
              <Metric value={`${Math.round(environment.tempC)}°C`} label="Temperature" />
              <Metric value={`${Math.round(environment.humidity)}%`} label="Humidity" />
              <Metric
                value={
                  environment.heatIndexC === null
                    ? ABSENT
                    : `${Math.round(environment.heatIndexC)}°C`
                }
                label="Heat index"
              />
            </View>
          </Card>

          <Card>
            <View style={styles.cardHeader}>
              <ThemedText type="smallBold">Air Quality</ThemedText>
              {environment.aqiCategory === null ? null : (
                <LevelChip
                  label={environment.aqiCategory.label}
                  level={environment.aqiCategory.level}
                />
              )}
            </View>
            <View style={styles.metricsRow}>
              <Metric
                value={environment.aqi === null ? ABSENT : String(environment.aqi)}
                label="AQI (US EPA)"
              />
              <Metric
                value={
                  environment.pollutants?.pm2_5 === undefined
                    ? ABSENT
                    : environment.pollutants.pm2_5.toFixed(1)
                }
                label="PM2.5 µg/m³"
              />
              <Metric
                value={
                  environment.pollutants?.pm10 === undefined
                    ? ABSENT
                    : String(Math.round(environment.pollutants.pm10))
                }
                label="PM10 µg/m³"
              />
            </View>
            {/* The provenance caveat belongs on the card, not only in the source. EPA's PM
                breakpoints are defined on 24-hour averages and this is derived from a
                current reading, so the index is an estimate — and when the pollutant
                figures are missing entirely it is only a coarse band. */}
            <ThemedText type="small" themeColor="textSecondary">
              {environment.aqi === null
                ? 'Air quality data was not available for this location.'
                : environment.aqiBasis === 'owm_index'
                  ? 'Approximate band only — pollutant concentrations were unavailable.'
                  : 'Estimated from current PM2.5 and PM10 concentrations.'}
            </ThemedText>
          </Card>

          {environment.advisories.length > 0 ? (
            <>
              <ThemedText type="smallBold">Active advisories</ThemedText>
              {environment.advisories.map((advisory) => (
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
            </>
          ) : (
            <Card>
              <ThemedText type="smallBold">No advisories</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                Heat and air quality are both within ordinary ranges right now.
              </ThemedText>
            </Card>
          )}
        </>
      )}
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
  refresh: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
  },
});
