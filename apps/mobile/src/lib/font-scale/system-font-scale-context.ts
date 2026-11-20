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

/**
 * The system font scale at and above which the shell lays text out for a large
 * font instead of truncating it: a settings row stacks its tile above its text,
 * a row title and a header title may take a second line, a key/value row puts
 * its value under its label, and a header's inline cluster (the account picker)
 * takes its own row under the title. Android's two largest font sizes (1.8 and
 * 2.0) reach it.
 */
export const LARGE_FONT_SCALE = 1.8;

/**
 * The scale the provider resolved for layout decisions: the live value, or
 * React Native's window value where the build has no live module (iOS). The
 * provider reads both once for the whole tree, so a row decides its shape from
 * context alone. `null` outside the provider, which reads as the default scale.
 */
export const LayoutFontScaleContext = createContext<number | null>(null);

/** Whether the system font scale has reached {@link LARGE_FONT_SCALE}. */
export function useIsLargeFontScale(): boolean {
  return (useContext(LayoutFontScaleContext) ?? 1) >= LARGE_FONT_SCALE;
}
