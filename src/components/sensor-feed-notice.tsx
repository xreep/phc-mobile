/**
 * One row under the vitals card that explains an empty live buffer (PRD §7.2.4 Dashboard).
 *
 * Deliberately silent on the simulated source and once live readings exist — a status line
 * that is always present is one nobody reads. The only tappable state is the one a tap can
 * change: permission-required raises the Health Connect dialog through the feed's
 * user-initiated `requestAccess`.
 */

import { Pressable, StyleSheet } from 'react-native';

import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { SensorFailure, SensorFeedStatus } from '@/sensors/types';

export type FeedNotice = {
  readonly title: string;
  readonly hint: string;
  readonly actionable: boolean;
};

export type NoticeInput = {
  readonly live: boolean;
  readonly status: SensorFeedStatus;
  readonly failure: SensorFailure | null;
  readonly readingCount: number;
};

export function noticeFor({ live, status, failure, readingCount }: NoticeInput): FeedNotice | null {
  if (!live) return null;
  switch (status) {
    case 'idle':
    case 'loading':
      return {
        title: 'Connecting to Health Connect',
        hint: 'Checking access to your health data…',
        actionable: false,
      };
    case 'permission-required':
      return {
        title: 'Health Connect access needed',
        hint: 'Tap to allow reading heart rate, blood oxygen and skin temperature from your paired band or watch.',
        actionable: true,
      };
    case 'unavailable':
      return {
        title: 'Health Connect unavailable',
        hint: failure?.message ?? 'Health Connect is not available on this device.',
        actionable: false,
      };
    case 'error':
      return {
        title: 'Health Connect read failed',
        hint: failure?.message ?? 'Could not read from Health Connect.',
        actionable: false,
      };
    case 'live':
      return readingCount === 0
        ? {
            title: 'Waiting for Health Connect',
            hint: 'No readings in the last few minutes. Make sure your band or watch has synced.',
            actionable: false,
          }
        : null;
  }
}

export type SensorFeedNoticeProps = NoticeInput & {
  readonly onRequestAccess: () => void;
};

export function SensorFeedNotice({ onRequestAccess, ...input }: SensorFeedNoticeProps) {
  const notice = noticeFor(input);
  if (notice === null) return null;

  return (
    <Pressable
      accessibilityRole={notice.actionable ? 'button' : undefined}
      disabled={!notice.actionable}
      onPress={onRequestAccess}
      style={({ pressed }) => [pressed && notice.actionable && styles.pressed]}>
      <Card style={styles.card}>
        <ThemedText type="smallBold">{notice.title}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {notice.hint}
        </ThemedText>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.8,
  },
});
