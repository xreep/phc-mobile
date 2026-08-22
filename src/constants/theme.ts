/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#000000',
    background: '#ffffff',
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

/**
 * Semantic "traffic-light" palette for risk indicators, AQI categories, and
 * heat-index bands (PRD §7.2.4). `fg` is used for the status dot and label
 * text; `bg` is a subtle tinted surface behind a card or chip.
 */
export const RiskColors = {
  light: {
    green: { fg: '#1A7F37', bg: '#E6F4EA' },
    amber: { fg: '#9A6700', bg: '#FFF4D6' },
    red: { fg: '#C1121F', bg: '#FDE7E9' },
    neutral: { fg: '#60646C', bg: '#F0F0F3' },
  },
  dark: {
    green: { fg: '#3FB950', bg: '#12261A' },
    amber: { fg: '#E3B341', bg: '#2A2410' },
    red: { fg: '#F85149', bg: '#2B1416' },
    neutral: { fg: '#B0B4BA', bg: '#212225' },
  },
} as const;

export type RiskColorKey = keyof typeof RiskColors.light & keyof typeof RiskColors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
