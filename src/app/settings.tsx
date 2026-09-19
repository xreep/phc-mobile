import { useState } from 'react';
import { Pressable, StyleSheet, Switch, TextInput, View } from 'react-native';

import { useAlertPermission } from '@/alerts/provider';
import { Card } from '@/components/card';
import { ContactEditor } from '@/components/contact-editor';
import { Screen } from '@/components/screen';
import { SettingRow } from '@/components/setting-row';
import { ThemedText } from '@/components/themed-text';
import { DATA_SHARING_PREFS, SENSOR_SOURCES } from '@/constants/health-data';
import { Spacing } from '@/constants/theme';
import { useRiskColors, useTheme } from '@/hooks/use-theme';
import { AGE_BANDS } from '@/settings/profile';
import { useSettings } from '@/settings/provider';
import { formatPhoneForDisplay, isTwilioConfigured, type EmergencyContact } from '@/sos';

/** What the editor is currently doing. `null` closed; `'new'` creating; otherwise editing. */
type EditorTarget = EmergencyContact | 'new' | null;

export default function SettingsScreen() {
  const {
    settings,
    loaded,
    writeFailed,
    addContact,
    removeContact,
    setUserName,
    setSharing,
    setSensorSource,
    setProfile,
    setAlertsEnabled,
  } = useSettings();
  const theme = useTheme();
  const risk = useRiskColors();

  const [editing, setEditing] = useState<EditorTarget>(null);
  /** Non-null only while the name field is being edited, so the stored value still shows
   *  through before storage has resolved. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const relayConfigured = isTwilioConfigured();

  // M3 alerts. `AlertsProvider` (mounted in `_layout.tsx`) owns the one shared permission state
  // — the Dashboard's `useAlerts` reads the same value, so a grant made here reaches it without a
  // remount. See `@/alerts/provider`'s module doc for why a private copy here was the bug.
  const { permission: alertPermission, requestPermission: requestAlertPermission } = useAlertPermission();

  const handleAlertsToggle = (value: boolean) => {
    setAlertsEnabled(value);
    // User-initiated only — the prompt must never appear from an effect. Turning the toggle off
    // never touches the OS permission; there is nothing to ask for.
    if (value) requestAlertPermission();
  };

  return (
    <Screen title="Settings" subtitle="Emergency contacts, privacy & data sources">
      {writeFailed ? (
        <Card style={{ backgroundColor: risk.red.bg }}>
          <ThemedText type="smallBold" style={{ color: risk.red.fg }}>
            Changes could not be saved
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Device storage rejected the write, so anything you change here will be lost when the
            app restarts. Free up space and reopen Settings.
          </ThemedText>
        </Card>
      ) : null}

      <ThemedText type="smallBold">Your name</ThemedText>
      <Card>
        <ThemedText type="small" themeColor="textSecondary">
          Included in the SOS message so a contact knows who needs help. Optional — without it
          the alert says “Someone needs help”.
        </ThemedText>
        <TextInput
          value={nameDraft ?? settings.userName}
          onChangeText={setNameDraft}
          onBlur={() => {
            if (nameDraft !== null) setUserName(nameDraft.trim());
            setNameDraft(null);
          }}
          placeholder="Your name"
          placeholderTextColor={theme.textSecondary}
          style={[styles.input, { backgroundColor: theme.backgroundSelected, color: theme.text }]}
          accessibilityLabel="Your name"
        />
      </Card>

      <ThemedText type="smallBold">Emergency contacts</ThemedText>
      <Card>
        {settings.contacts.length === 0 ? (
          // Deliberately empty rather than seeded with demo numbers: SOS now really sends, and
          // a plausible-looking placeholder would text a stranger on the first press.
          <ThemedText type="small" themeColor="textSecondary">
            {loaded
              ? 'No contacts yet. Emergency SOS has nowhere to send until you add at least one.'
              : 'Loading your contacts…'}
          </ThemedText>
        ) : (
          settings.contacts.map((contact) => (
            <Pressable
              key={contact.id}
              accessibilityRole="button"
              onPress={() => setEditing(contact)}
              style={({ pressed }) => pressed && styles.pressed}>
              <SettingRow
                title={contact.name}
                description={
                  contact.relation.length > 0
                    ? `${contact.relation} · ${formatPhoneForDisplay(contact.phone)}`
                    : formatPhoneForDisplay(contact.phone)
                }>
                <ThemedText type="small" themeColor="textSecondary">
                  Edit
                </ThemedText>
              </SettingRow>
            </Pressable>
          ))
        )}
      </Card>
      <Pressable
        accessibilityRole="button"
        onPress={() => setEditing('new')}
        style={({ pressed }) => pressed && styles.pressed}>
        <ThemedText type="linkPrimary">+ Add emergency contact</ThemedText>
      </Pressable>

      <ThemedText type="smallBold">How SOS sends</ThemedText>
      <Card>
        <SettingRow
          title={relayConfigured ? 'Automatic relay configured' : 'Automatic relay not configured'}
          description={
            relayConfigured
              ? 'Alerts send by themselves. If the relay cannot be reached, your SMS app opens with the message ready.'
              : 'Set EXPO_PUBLIC_TWILIO_SOS_URL in .env.local to send automatically. Until then SOS opens your SMS app with the message ready — you press send.'
          }>
          <View
            style={[
              styles.dot,
              { backgroundColor: relayConfigured ? risk.green.fg : risk.amber.fg },
            ]}
          />
        </SettingRow>
        {/* Stated here, in calm conditions, because it cannot be discovered during an
            emergency: the SMS fallback opens a composer and the platform reserves the send
            action for the user. */}
        <ThemedText type="small" themeColor="textSecondary">
          The SMS fallback works without mobile data, but it always needs you to press send —
          Android and iOS never let an app send a text on its own.
        </ThemedText>
      </Card>

      <ThemedText type="smallBold">About you</ThemedText>
      <Card>
        <ThemedText type="small" themeColor="textSecondary">
          Used to tailor risk warnings on this phone. Never sent anywhere.
        </ThemedText>
        {AGE_BANDS.map((band) => {
          const selected = band.key === settings.profile.ageBand;
          return (
            <Pressable
              key={band.key}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => setProfile({ ageBand: band.key })}>
              <SettingRow title={band.label}>
                <View
                  style={[
                    styles.radio,
                    { borderColor: selected ? theme.text : theme.textSecondary },
                  ]}>
                  {selected ? (
                    <View style={[styles.radioDot, { backgroundColor: theme.text }]} />
                  ) : null}
                </View>
              </SettingRow>
            </Pressable>
          );
        })}
        <SettingRow
          title="Long-term health condition"
          description="e.g. asthma, heart condition, diabetes">
          <Switch
            value={settings.profile.chronicCondition}
            onValueChange={(value) => setProfile({ chronicCondition: value })}
            accessibilityLabel="Long-term health condition"
          />
        </SettingRow>
        <SettingRow title="Works outdoors" description="e.g. farming, construction, delivery">
          <Switch
            value={settings.profile.outdoorWorker}
            onValueChange={(value) => setProfile({ outdoorWorker: value })}
            accessibilityLabel="Works outdoors"
          />
        </SettingRow>
        <SettingRow title="Pregnant">
          <Switch
            value={settings.profile.pregnant}
            onValueChange={(value) => setProfile({ pregnant: value })}
            accessibilityLabel="Pregnant"
          />
        </SettingRow>
      </Card>

      <ThemedText type="smallBold">Data sharing</ThemedText>
      <Card>
        {DATA_SHARING_PREFS.map((pref) => (
          <SettingRow key={pref.key} title={pref.label} description={pref.description}>
            <Switch
              value={settings.sharing[pref.key]}
              onValueChange={(value) => setSharing(pref.key, value)}
              accessibilityLabel={pref.label}
            />
          </SettingRow>
        ))}
      </Card>
      <ThemedText type="small" themeColor="textSecondary">
        All sharing is off by default except emergency SOS, which is the one path that sends
        anything off this device: an SOS carries your name, your latest vitals, and your
        coordinates to the contacts you have added, through your SMS app or your configured relay.
        Nothing else is uploaded anywhere. Turning off emergency SOS stops the app alerting your
        contacts at all, including automatically.
      </ThemedText>

      <ThemedText type="smallBold">Sensor source</ThemedText>
      <Card>
        {SENSOR_SOURCES.map((option) => {
          const selected = option.key === settings.sensorSource;
          return (
            <Pressable
              key={option.key}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => setSensorSource(option.key)}>
              <SettingRow title={option.label} description={option.description}>
                <View
                  style={[
                    styles.radio,
                    { borderColor: selected ? theme.text : theme.textSecondary },
                  ]}>
                  {selected ? (
                    <View style={[styles.radioDot, { backgroundColor: theme.text }]} />
                  ) : null}
                </View>
              </SettingRow>
            </Pressable>
          );
        })}
      </Card>

      <ThemedText type="smallBold">Alerts</ThemedText>
      <Card>
        <SettingRow
          title="Alert notifications"
          description="Get a notification when a risk card rises to elevated or high, or a critical trigger appears. Foreground only for now — the app has to be open to notice a change.">
          <Switch
            value={settings.alerts.enabled}
            onValueChange={handleAlertsToggle}
            accessibilityLabel="Alert notifications"
          />
        </SettingRow>
        {alertPermission === 'denied' ? (
          <ThemedText type="small" style={{ color: risk.red.fg }}>
            Notifications are blocked for this app — enable them in Android settings.
          </ThemedText>
        ) : null}
        {/* On by default (`DEFAULT_SETTINGS.alerts.enabled`), which means a fresh Android 13+
            install can reach this screen with the toggle already on but the OS permission still
            `'undetermined'` — nobody has been asked yet, and an undetermined permission renders no
            hint on its own. Offering the prompt here, rather than waiting for some other
            user-initiated moment that may never come, is what actually gets the notification the
            toggle promises. */}
        {settings.alerts.enabled && alertPermission === 'undetermined' ? (
          <Pressable
            accessibilityRole="button"
            onPress={requestAlertPermission}
            style={({ pressed }) => pressed && styles.pressed}>
            <ThemedText type="linkPrimary">Turn on notifications</ThemedText>
          </Pressable>
        ) : null}
      </Card>

      {editing !== null ? (
        <ContactEditor
          contact={editing === 'new' ? null : editing}
          onSave={addContact}
          onDelete={removeContact}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.6,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
