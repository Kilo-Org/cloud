import { createContext, useContext } from 'react';
import { useWindowDimensions } from 'react-native';

/**
 * The live system font scale, or `null` outside the provider.
 *
 * The context lives in its own module so a component that only reads the value
 * — the shared `Text` and `Input` — does not pull the Expo runtime in with it.
 */
export const SystemFontScaleContext = createContext<number | null>(null);

export function useSystemFontScale(): number | null {
  return useContext(SystemFontScaleContext);
}

/**
 * The system font scale for anything that sizes itself from it.
 *
 * Prefers the live value; without one (a build with no `KiloFontScale` module,
 * or a tree rendered outside the provider) it falls back to React Native's own
 * dimensions, which is the value the app used before the live module existed.
 */
export function useLiveFontScale(): number {
  const live = useSystemFontScale();
  const { fontScale } = useWindowDimensions();
  return live ?? fontScale;
}
