/**
 * Add or edit an emergency contact.
 *
 * ## Why the country code is required rather than assumed
 * `phone.ts` rejects a bare 10-digit number instead of prefixing `+91`, and this form is where
 * the user meets that decision, so it has to explain it rather than just refuse. The reason is
 * worth the friction: a wrong country code does not fail — it routes an emergency message to a
 * real stranger in another country, and nothing in the app or the relay would report anything
 * amiss. Guessing is the expensive option here.
 *
 * ## The normalized number is echoed back before saving
 * The form shows exactly what will be dialled once the input parses. An emergency contact is
 * the one field in this app where a typo is silent until it matters, and confirming the parsed
 * result is the only feedback available short of sending a test message.
 *
 * ## Telegram linking lives here, per contact
 * A linked contact gets the alert on Telegram (free, no tap on the user's side) as well as by
 * SMS. The link is a one-time deep link the contact taps — see `src/sos/telegram-link.ts` for
 * the token and `src/hooks/use-telegram-link.ts` for the polling. The chat id lands in the
 * editor's draft and is stored when the contact is saved, so "Cancel" discards it like any
 * other unsaved edit; the copy says so. Sharing goes through the platform share sheet only —
 * `expo-clipboard` is not installed, and the share sheet reaches every messaging app a
 * caregiver might already be in.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, Share, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTelegramLink, type UseTelegramLinkOptions } from '@/hooks/use-telegram-link';
import { useRiskColors, useTheme } from '@/hooks/use-theme';
import {
  formatPhoneForDisplay,
  isRelayConfigured,
  normalizePhone,
  telegramLinkInstructions,
  type EmergencyContact,
} from '@/sos';

/** Monotonic suffix so two contacts created in the same millisecond still differ. */
let sequence = 0;

function newContactId(): string {
  sequence += 1;
  return `c${Date.now().toString(36)}${sequence.toString(36)}`;
}

export type ContactEditorProps = {
  /** The contact being edited, or null to create one. */
  readonly contact: EmergencyContact | null;
  readonly onSave: (contact: EmergencyContact) => void;
  readonly onDelete?: (id: string) => void;
  readonly onClose: () => void;
  /** Injected in tests: the platform share sheet. Defaults to RN's `Share.share`. */
  readonly shareImpl?: (message: string) => Promise<unknown>;
  /** Injected in tests: the relay calls behind the Telegram link. */
  readonly linkOptions?: UseTelegramLinkOptions;
};

export function ContactEditor({
  contact,
  onSave,
  onDelete,
  onClose,
  shareImpl,
  linkOptions,
}: ContactEditorProps) {
  const theme = useTheme();
  const risk = useRiskColors();

  const [name, setName] = useState(contact?.name ?? '');
  const [relation, setRelation] = useState(contact?.relation ?? '');
  // Seeded with the stored E.164 rather than a prettified form: what is shown is what is
  // stored, so an edit round-trip cannot quietly change the number.
  const [phone, setPhone] = useState(contact?.phone ?? '+91');
  // The draft chat id: the stored one, replaced when a link lands, cleared by Unlink. Saved
  // with the rest of the form, so it is discarded with the rest of the form on Cancel.
  const [telegramChatId, setTelegramChatId] = useState<string | undefined>(
    contact?.telegramChatId,
  );

  const link = useTelegramLink({
    ...linkOptions,
    onLinked: (chatId) => {
      setTelegramChatId(chatId);
      linkOptions?.onLinked?.(chatId);
    },
  });
  // The hook stops itself on unmount; this also stops it if the editor is ever kept mounted
  // and pointed at a different contact.
  const resetLink = link.reset;
  useEffect(() => () => resetLink(), [resetLink]);

  const relayConfigured =
    linkOptions?.endpoint !== undefined ? linkOptions.endpoint !== null : isRelayConfigured();

  const trimmedName = name.trim();
  const normalized = normalizePhone(phone);
  const phoneTouched = phone.trim().length > 0 && phone.trim() !== '+91';
  const canSave = trimmedName.length > 0 && normalized !== null;

  const inputStyle = [
    styles.input,
    { backgroundColor: theme.backgroundElement, color: theme.text },
  ];

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <ThemedView style={[styles.sheet, { backgroundColor: theme.background }]}>
          <ThemedText type="smallBold">
            {contact === null ? 'Add emergency contact' : 'Edit emergency contact'}
          </ThemedText>

          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Name
            </ThemedText>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Priya Sharma"
              placeholderTextColor={theme.textSecondary}
              style={inputStyle}
              accessibilityLabel="Contact name"
            />
          </View>

          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Relationship (optional)
            </ThemedText>
            <TextInput
              value={relation}
              onChangeText={setRelation}
              placeholder="Daughter"
              placeholderTextColor={theme.textSecondary}
              style={inputStyle}
              accessibilityLabel="Relationship"
            />
          </View>

          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Phone number, with country code
            </ThemedText>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder="+91 98765 43210"
              placeholderTextColor={theme.textSecondary}
              keyboardType="phone-pad"
              autoComplete="tel"
              style={inputStyle}
              accessibilityLabel="Phone number"
            />
            {normalized !== null ? (
              <ThemedText type="small" style={{ color: risk.green.fg }}>
                Will send to {formatPhoneForDisplay(normalized)}
              </ThemedText>
            ) : phoneTouched ? (
              <ThemedText type="small" style={{ color: risk.red.fg }}>
                Include the country code, for example +91 for India. SOS will not guess it — a
                wrong code sends the alert to a stranger.
              </ThemedText>
            ) : (
              <ThemedText type="small" themeColor="textSecondary">
                Start with + and the country code.
              </ThemedText>
            )}
          </View>

          <View style={styles.field}>
            <ThemedText type="small" themeColor="textSecondary">
              Telegram alerts
            </ThemedText>
            <TelegramLinkSection
              linked={telegramChatId !== undefined}
              unsaved={telegramChatId !== contact?.telegramChatId}
              relayConfigured={relayConfigured}
              link={link}
              onUnlink={() => {
                setTelegramChatId(undefined);
                link.reset();
              }}
              onShare={(message) => {
                // The share sheet failing (no apps, dismissed) is not an error the user can act
                // on, and the link is on screen regardless.
                const share = shareImpl ?? ((text: string) => Share.share({ message: text }));
                void share(message).catch(() => undefined);
              }}
            />
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={!canSave}
            onPress={() => {
              if (normalized === null) return;
              onSave({
                id: contact?.id ?? newContactId(),
                name: trimmedName,
                relation: relation.trim(),
                phone: normalized,
                ...(telegramChatId !== undefined ? { telegramChatId } : {}),
              });
              onClose();
            }}
            style={({ pressed }) => [
              styles.primary,
              !canSave && styles.disabled,
              pressed && styles.pressed,
            ]}>
            <ThemedText style={styles.primaryLabel}>Save contact</ThemedText>
          </Pressable>

          {contact !== null && onDelete !== undefined ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onDelete(contact.id);
                onClose();
              }}
              style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
              <ThemedText type="smallBold" style={{ color: risk.red.fg }}>
                Remove contact
              </ThemedText>
            </Pressable>
          ) : null}

          <Pressable
            accessibilityRole="button"
            onPress={onClose}
            style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              Cancel
            </ThemedText>
          </Pressable>
        </ThemedView>
      </View>
    </Modal>
  );
}

/**
 * The Telegram row: linked / not linked / the link in progress.
 *
 * Every state names its next action. "Linked" says the save is still needed only when it is —
 * a user who links and then cancels would otherwise believe the contact receives Telegram
 * alerts when the store never heard about it; a user opening a contact linked last week must
 * not be told to save something that is already saved.
 */
function TelegramLinkSection({
  linked,
  unsaved,
  relayConfigured,
  link,
  onUnlink,
  onShare,
}: {
  linked: boolean;
  /** The draft chat id differs from the stored one — the link is not persisted until Save. */
  unsaved: boolean;
  relayConfigured: boolean;
  link: ReturnType<typeof useTelegramLink>;
  onUnlink: () => void;
  onShare: (message: string) => void;
}) {
  const risk = useRiskColors();
  const { state } = link;

  if (linked) {
    return (
      <>
        <ThemedText type="small" style={{ color: risk.green.fg }}>
          {unsaved
            ? 'Linked ✓ — alerts also go to this contact on Telegram. Save the contact to keep it.'
            : 'Linked ✓ — alerts also go to this contact on Telegram.'}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          onPress={onUnlink}
          style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}>
          <ThemedText type="smallBold" themeColor="textSecondary">
            Unlink Telegram
          </ThemedText>
        </Pressable>
      </>
    );
  }

  if (!relayConfigured) {
    return (
      <ThemedText type="small" themeColor="textSecondary">
        Relay not configured — Telegram linking needs EXPO_PUBLIC_SOS_RELAY_URL. SMS still works.
      </ThemedText>
    );
  }

  if (state.status === 'waiting') {
    const instructions = telegramLinkInstructions(state.botUsername, state.linkToken);
    return (
      <>
        <ThemedText type="small" themeColor="textSecondary">
          {instructions}
        </ThemedText>
        <ThemedText type="code" selectable accessibilityLabel="Telegram link">
          {state.link}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          onPress={() => onShare(`${state.link}\n\n${instructions}`)}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
          <ThemedText type="smallBold">Share link</ThemedText>
        </Pressable>
        <ThemedText type="small" themeColor="textSecondary">
          Waiting for the contact to press Start… this link works for 10 minutes.
        </ThemedText>
      </>
    );
  }

  const linkButton = (label: string) => (
    <Pressable
      accessibilityRole="button"
      onPress={link.start}
      style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}>
      <ThemedText type="smallBold">{label}</ThemedText>
    </Pressable>
  );

  if (state.status === 'starting') {
    return (
      <ThemedText type="small" themeColor="textSecondary">
        Contacting the relay…
      </ThemedText>
    );
  }
  if (state.status === 'expired') {
    return (
      <>
        <ThemedText type="small" style={{ color: risk.amber.fg }}>
          Link expired — try again.
        </ThemedText>
        {linkButton('Link Telegram again')}
      </>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <ThemedText type="small" themeColor="textSecondary">
        {state.error}
      </ThemedText>
    );
  }
  if (state.status === 'failed') {
    return (
      <>
        <ThemedText type="small" style={{ color: risk.red.fg }}>
          {state.error}
        </ThemedText>
        {linkButton('Link Telegram again')}
      </>
    );
  }

  // `idle`, and `linked`-then-unlinked (the draft is cleared; the hook's state is reset).
  return (
    <>
      <ThemedText type="small" themeColor="textSecondary">
        Optional. A linked contact also gets the alert on Telegram, with no tap needed from you.
        Send them a one-time link to set it up.
      </ThemedText>
      {linkButton('Link Telegram')}
    </>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Spacing.four,
    borderTopRightRadius: Spacing.four,
    padding: Spacing.four,
    gap: Spacing.three,
  },
  field: {
    gap: Spacing.one,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  primary: {
    backgroundColor: '#3c87f7',
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  primaryLabel: {
    color: '#ffffff',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: 700,
  },
  textButton: {
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
  secondary: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.two,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#3c87f7',
  },
  inlineButton: {
    paddingVertical: Spacing.one,
    alignItems: 'flex-start',
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.8,
  },
});
