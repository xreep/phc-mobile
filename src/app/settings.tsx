import { useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import { Card } from '@/components/card';
import { Screen } from '@/components/screen';
import { SettingRow } from '@/components/setting-row';
import { ThemedText } from '@/components/themed-text';
import {
  DATA_SHARING_PREFS,
  DEFAULT_SENSOR_SOURCE,
  EMERGENCY_CONTACTS,
  SENSOR_SOURCES,
  type SensorSourceOption,
} from '@/constants/health-data';
import { useTheme } from '@/hooks/use-theme';

export default function SettingsScreen() {
  const [sharing, setSharing] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(DATA_SHARING_PREFS.map((pref) => [pref.key, pref.defaultOn])),
  );
  const [source, setSource] = useState<SensorSourceOption['key']>(DEFAULT_SENSOR_SOURCE);
  const theme = useTheme();

  return (
    <Screen title="Settings" subtitle="Emergency contacts, privacy & data sources">
      <ThemedText type="smallBold">Emergency contacts</ThemedText>
      <Card>
        {EMERGENCY_CONTACTS.map((contact) => (
          <SettingRow
            key={contact.id}
            title={contact.name}
            description={`${contact.relation} · ${contact.phone}`}
          />
        ))}
      </Card>
      <Pressable style={({ pressed }) => pressed && styles.pressed}>
        <ThemedText type="linkPrimary">+ Add emergency contact</ThemedText>
      </Pressable>

      <ThemedText type="smallBold">Data sharing</ThemedText>
      <Card>
        {DATA_SHARING_PREFS.map((pref) => (
          <SettingRow key={pref.key} title={pref.label} description={pref.description}>
            <Switch
              value={sharing[pref.key]}
              onValueChange={(value) => setSharing((prev) => ({ ...prev, [pref.key]: value }))}
            />
          </SettingRow>
        ))}
      </Card>
      <ThemedText type="small" themeColor="textSecondary">
        All sharing is off by default except emergency SOS. No raw health data leaves your device.
      </ThemedText>

      <ThemedText type="smallBold">Sensor source</ThemedText>
      <Card>
        {SENSOR_SOURCES.map((option) => {
          const selected = option.key === source;
          return (
            <Pressable key={option.key} onPress={() => setSource(option.key)}>
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.6,
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
