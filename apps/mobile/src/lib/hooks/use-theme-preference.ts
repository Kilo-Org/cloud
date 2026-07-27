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

export function setThemePreference(pref: ThemePreference): void {
  store.set(pref);
  // Apply synchronously so a same-render useColorScheme() read sees the new
  // value without waiting for the async disk persist to settle.
  applyThemePreference(pref);
}

export function useThemePreference() {
  const preference = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { preference, hasLoaded };
}
