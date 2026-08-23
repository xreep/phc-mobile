import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { EnvironmentProvider } from '@/environment/provider';

SplashScreen.preventAutoHideAsync();

export default function TabLayout() {
  const colorScheme = useColorScheme();
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      {/* Mounted above the tabs so the Environment screen and the Dashboard's risk engine
          read one observation from one fetch — see `environment/provider.tsx`. */}
      <EnvironmentProvider>
        <AnimatedSplashOverlay />
        <AppTabs />
      </EnvironmentProvider>
    </ThemeProvider>
  );
}
