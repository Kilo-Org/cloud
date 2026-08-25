import { useSyncExternalStore } from 'react';

import { isSupportedLanguage, type SupportedLanguage } from '@/i18n/languages';
import { resolveDeviceLanguage } from '@/i18n/resolve-language';
import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { LANGUAGE_PREFERENCE_KEY } from '@/lib/storage-keys';

export type LanguagePreference = 'device' | SupportedLanguage;

/** Maps any raw stored value to a valid preference; unknown values become `device`. */
export function parseLanguagePreference(raw: string | null): LanguagePreference {
  if (raw === 'device') {
    return 'device';
  }
  if (isSupportedLanguage(raw ?? '')) {
    return raw as SupportedLanguage;
  }
  return 'device';
}

const store = createSecureStorePreference<LanguagePreference>({
  key: LANGUAGE_PREFERENCE_KEY,
  defaultValue: 'device',
  parse: parseLanguagePreference,
  serialize: value => value,
});

/** The active language: the stored override, or the resolved device language. */
export function getResolvedLanguage(): SupportedLanguage {
  const preference = store.get();
  return preference === 'device' ? resolveDeviceLanguage() : preference;
}

/** The raw stored preference (device or a supported tag). */
export function getLanguagePreference(): LanguagePreference {
  return store.get();
}

/** Apply and persist a preference; returns false when the disk write failed. */
export async function setLanguagePreferenceAsync(
  preference: LanguagePreference,
  toastLng?: string
): Promise<boolean> {
  const result = await store.setAsync(preference, toastLng);
  return result;
}

/** Start the disk read at module scope, before React mounts. */
export function preloadLanguagePreference(): void {
  store.preload();
}

export function useLanguagePreference() {
  const preference = useSyncExternalStore(store.subscribe, store.get);
  const hasLoaded = useSyncExternalStore(store.subscribe, store.getHasLoaded);
  return { preference, hasLoaded };
}
