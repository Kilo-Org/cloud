import { useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { THEME_PREFERENCE_KEY } from '@/lib/storage-keys';

export type ThemePreference = 'system' | 'light' | 'dark';

const store = createSecureStorePreference<ThemePreference>({
  key: THEME_PREFERENCE_KEY,
  defaultValue: 'system',
  parse: raw => {
    if (raw === 'light' || raw === 'dark' || raw === 'system') {
      return raw;
    }
    return 'system';
  },
  serialize: value => value,
});

export function colorSchemeForPreference(pref: ThemePreference): 'light' | 'dark' | null {
  if (pref === 'system') {
    return null;
  }
  return pref;
}

export function applyThemePreference(pref: ThemePreference): void {
  // ColorSchemeName = 'light' | 'dark' | 'unspecified' — there is no null sentinel,
  // so the pure helper's `null` (meaning "follow the system") becomes 'unspecified'
  // at the Appearance boundary.
  Appearance.setColorScheme(colorSchemeForPreference(pref) ?? 'unspecified');
}

/** The stored theme preference for callers with no React tree (the settings registry). */
export function getThemePreference(): ThemePreference {
  return store.get();
}

export function setThemePreference(pref: ThemePreference): void {
  // Appearance first, then the store emit: notifying subscribers and then
  // changing the scheme updates useColorScheme on components still mounting
  // from that emit (LogBox: "Can't perform a React state update on a
  // component that hasn't mounted yet" over the tab bar).
  applyThemePreference(pref);
  store.set(pref);
}

/** Start the theme-preference disk read at module scope, before React mounts. */
export function preloadThemePreference(): void {
  store.preload();
}

export function useThemePreference() {
  const preference = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { preference, hasLoaded };
}
