import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AlertsProvider } from '@/alerts/provider';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { EnvironmentProvider } from '@/environment/provider';
import { SensorProvider } from '@/sensors/provider';
import { SettingsProvider } from '@/settings/provider';
import { ReadingStoreProvider } from '@/store/provider';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* Mounted above the tabs so the Environment screen and the Dashboard's risk engine
          read one observation from one fetch — see `environment/provider.tsx`. */}
      <EnvironmentProvider>
        {/* Same reason, higher stakes: Settings edits the emergency contact list and the
            Dashboard's SOS path reads it. Two copies would let a contact added in one be
            invisible to the other. */}
        <SettingsProvider>
          {/* Above the sensor feed, which appends to and warm-starts from it, and above Settings'
              "Erase my health data", which clears it: one store, so a reading cannot be persisted
              in one instance and erased from another (`@/store/provider`'s module doc). */}
          <ReadingStoreProvider>
            {/* Inside Settings because the picker there is what switches the feed on; the
                Dashboard's risk engine and Settings then agree on which source is live. */}
            <SensorProvider>
              {/* Also inside Settings: it reads the "Alert notifications" toggle to decide when to
                  re-read the OS permission (`@/alerts/provider`'s module doc), and it is the one
                  shared permission both the Settings screen and the Dashboard's `useAlerts` read —
                  two independent copies is the bug this file exists to prevent. */}
              <AlertsProvider>
                <AnimatedSplashOverlay />
                <AppTabs />
              </AlertsProvider>
            </SensorProvider>
          </ReadingStoreProvider>
        </SettingsProvider>
      </EnvironmentProvider>
    </ThemeProvider>
  );
}
