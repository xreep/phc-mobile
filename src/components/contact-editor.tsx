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
 */

import { useState } from 'react';
import { Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useRiskColors, useTheme } from '@/hooks/use-theme';
import { formatPhoneForDisplay, normalizePhone, type EmergencyContact } from '@/sos';

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
};

export function ContactEditor({ contact, onSave, onDelete, onClose }: ContactEditorProps) {
  const theme = useTheme();
  const risk = useRiskColors();

  const [name, setName] = useState(contact?.name ?? '');
  const [relation, setRelation] = useState(contact?.relation ?? '');
  // Seeded with the stored E.164 rather than a prettified form: what is shown is what is
  // stored, so an edit round-trip cannot quietly change the number.
  const [phone, setPhone] = useState(contact?.phone ?? '+91');

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
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.8,
  },
});
