/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors, RiskColors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useTheme() {
  const scheme = useColorScheme();
  const theme = scheme === 'unspecified' ? 'light' : scheme;

  return Colors[theme];
}

/**
 * Resolves the semantic risk palette (green/amber/red/neutral) for the active
 * color scheme. Used by risk cards, AQI/heat-index chips, etc.
 */
export function useRiskColors() {
  const scheme = useColorScheme();

  return RiskColors[scheme === 'dark' ? 'dark' : 'light'];
}
