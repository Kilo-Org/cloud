import { createContext, useContext } from 'react';

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
