/**
 * The SOS cancel window and its outcome (PRD §7.2.5 step 1: "local alert … with 30-second
 * cancel window").
 *
 * ## Why a full-screen modal rather than a banner
 * The window is 30 seconds long and closing it is irreversible. A banner competes with the
 * Dashboard's own content and can be scrolled past — which in this case means an emergency SMS
 * going to three people because the user did not notice a strip at the top of a screen they
 * were already looking at. A modal makes the one available action unmissable, and it is the
 * only place in this app where taking over the screen is the correct trade.
 *
 * ## The countdown is not the only cancel affordance
 * Cancel is a large target and the primary button. Android's back gesture is deliberately
 * *not* wired to it: a back press is muscle memory, and a reflexive one would dismiss a real
 * emergency alert with no record that it happened.
 */

import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import type { SosController } from '@/hooks/use-sos';
import { useRiskColors, useTheme } from '@/hooks/use-theme';
import { formatPhoneForDisplay } from '@/sos';

/** Local alert red. Matches the Dashboard's SOS button rather than the theme, because the
 *  meaning is fixed: this colour means "emergency" in both light and dark. */
const ALERT_RED = '#C1121F';

function ContactList({ contacts }: { contacts: SosController['contacts'] }) {
  return (
    <View style={styles.contactList}>
      {contacts.map((contact) => (
        <ThemedText key={contact.id} type="small" themeColor="textSecondary">
          {contact.name} · {formatPhoneForDisplay(contact.phone)}
        </ThemedText>
      ))}
    </View>
  );
}

export function SosAlert({ controller }: { controller: SosController }) {
  const {
    phase,
    secondsRemaining,
    manual,
    result,
    contacts,
    relayConfigured,
    cancel,
    dismiss,
    reasons,
  } = controller;

  const theme = useTheme();
  const risk = useRiskColors();

  if (phase === 'idle') return null;

  const isCountdown = phase === 'countdown';
  const isDispatching = phase === 'dispatching';

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      // A back press must not resolve an armed emergency. In terminal phases there is nothing
      // left to decide, so dismissing is safe.
      onRequestClose={isCountdown || isDispatching ? undefined : dismiss}>
      <View style={styles.scrim}>
        <ThemedView style={[styles.sheet, { backgroundColor: theme.background }]}>
          {isCountdown ? (
            <>
              <ThemedText type="smallBold" style={{ color: ALERT_RED }}>
                {manual ? 'EMERGENCY SOS' : 'CRITICAL RISK DETECTED'}
              </ThemedText>

              <ThemedText style={styles.countdown} accessibilityLabel={`${secondsRemaining} seconds to cancel`}>
                {secondsRemaining}
              </ThemedText>

              <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
                Alerting {contacts.length === 1 ? '1 contact' : `${contacts.length} contacts`} in{' '}
                {secondsRemaining}s
              </ThemedText>

              {reasons.length > 0 ? (
                <View style={styles.reasons}>
                  {reasons.map((reason) => (
                    <ThemedText key={reason} type="small">
                      · {reason}
                    </ThemedText>
                  ))}
                </View>
              ) : null}

              <ContactList contacts={contacts} />

              {/* Stated before the send, not after. A user who knows the relay is unconfigured
                  knows to expect their SMS app to open, which is the difference between the
                  fallback looking deliberate and looking like a malfunction. */}
              <ThemedText type="small" themeColor="textSecondary" style={styles.centered}>
                {relayConfigured
                  ? 'Sends automatically. Your SMS app opens if the relay cannot be reached.'
                  : 'No SOS relay configured — your SMS app will open with the message ready to send.'}
              </ThemedText>

              <Pressable
                accessibilityRole="button"
                onPress={cancel}
                style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
                <ThemedText style={styles.primaryLabel}>Cancel — I&apos;m OK</ThemedText>
              </Pressable>
            </>
          ) : null}

          {isDispatching ? (
            <>
              <ThemedText type="smallBold" style={{ color: ALERT_RED }}>
                SENDING
              </ThemedText>
              <ThemedText type="subtitle">Alerting your contacts</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                Getting your location and sending the alert. This cannot be cancelled.
              </ThemedText>
              <ContactList contacts={contacts} />
            </>
          ) : null}

          {phase === 'sent' ? (
            <>
              <ThemedText type="smallBold" style={{ color: risk.green.fg }}>
                SENT
              </ThemedText>
              <ThemedText type="subtitle">Alert sent</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {result === null
                  ? 'Your contacts have been alerted.'
                  : `Delivered to ${result.twilioSent.length === 1 ? '1 contact' : `${result.twilioSent.length} contacts`}.`}
              </ThemedText>
              {result !== null ? <SentMessage message={result.message} /> : null}
            </>
          ) : null}

          {phase === 'sms_pending' ? (
            <>
              <ThemedText type="smallBold" style={{ color: risk.amber.fg }}>
                NEEDS ONE MORE TAP
              </ThemedText>
              <ThemedText type="subtitle">Press send in your SMS app</ThemedText>
              {/* The single most important sentence in this component. Android and iOS both
                  reserve the send action for the user, so the message is composed and waiting,
                  not sent — and someone who believes otherwise puts the phone down. */}
              <ThemedText type="small">
                Your SMS app has opened with the message ready. It has <ThemedText type="smallBold">not</ThemedText> been
                sent yet — press send there to alert your contacts.
              </ThemedText>
              {result !== null ? <SentMessage message={result.message} /> : null}
            </>
          ) : null}

          {phase === 'failed' ? (
            <>
              <ThemedText type="smallBold" style={{ color: ALERT_RED }}>
                NOT SENT
              </ThemedText>
              <ThemedText type="subtitle">Could not send the alert</ThemedText>
              <ThemedText type="small">
                Nothing was delivered. Call your emergency contact directly.
              </ThemedText>
              {result !== null ? (
                <View style={styles.reasons}>
                  {result.attempts
                    .filter((attempt) => !attempt.ok && attempt.error !== undefined)
                    .map((attempt, index) => (
                      <ThemedText
                        key={`${attempt.contactId}-${attempt.channel}-${index}`}
                        type="small"
                        themeColor="textSecondary">
                        · {attempt.error}
                      </ThemedText>
                    ))}
                </View>
              ) : null}
            </>
          ) : null}

          {phase === 'cancelled' ? (
            <>
              <ThemedText type="subtitle">Cancelled</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                No alert was sent. You will be warned again if a new critical reading appears.
              </ThemedText>
            </>
          ) : null}

          {phase === 'no_contacts' ? (
            <>
              <ThemedText type="smallBold" style={{ color: risk.amber.fg }}>
                NO CONTACTS
              </ThemedText>
              <ThemedText type="subtitle">Nobody to alert</ThemedText>
              <ThemedText type="small">
                Add an emergency contact in Settings so SOS has somewhere to send.
              </ThemedText>
            </>
          ) : null}

          {phase === 'no_consent' ? (
            <>
              <ThemedText type="smallBold" style={{ color: risk.amber.fg }}>
                SOS IS OFF
              </ThemedText>
              <ThemedText type="subtitle">Emergency SOS is turned off</ThemedText>
              <ThemedText type="small">
                Turn on “Emergency SOS” under Data sharing in Settings to let the app alert your
                contacts.
              </ThemedText>
            </>
          ) : null}

          {isCountdown || isDispatching ? null : (
            <Pressable
              accessibilityRole="button"
              onPress={dismiss}
              style={({ pressed }) => [
                styles.secondary,
                { backgroundColor: theme.backgroundElement },
                pressed && styles.pressed,
              ]}>
              <ThemedText type="smallBold">Done</ThemedText>
            </Pressable>
          )}
        </ThemedView>
      </View>
    </Modal>
  );
}

/** The exact text that went out, so the user can see what their contacts received. */
function SentMessage({ message }: { message: string }) {
  return (
    <ThemedView type="backgroundElement" style={styles.messageBox}>
      <ThemedText type="code">{message}</ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  sheet: {
    borderRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  countdown: {
    fontSize: 72,
    lineHeight: 80,
    fontWeight: 700,
    textAlign: 'center',
    color: ALERT_RED,
  },
  centered: {
    textAlign: 'center',
  },
  reasons: {
    gap: Spacing.half,
  },
  contactList: {
    gap: Spacing.half,
  },
  messageBox: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
  },
  primary: {
    backgroundColor: ALERT_RED,
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  primaryLabel: {
    color: '#ffffff',
    fontSize: 18,
    lineHeight: 24,
    fontWeight: 700,
  },
  secondary: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  pressed: {
    opacity: 0.8,
  },
});
