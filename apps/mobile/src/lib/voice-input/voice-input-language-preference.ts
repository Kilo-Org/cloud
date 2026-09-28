import { useSyncExternalStore } from 'react';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { VOICE_INPUT_LANGUAGE_KEY } from '@/lib/storage-keys';

/**
 * The persisted voice-input language choice, a BCP-47 tag. `null` is the
 * "auto" default: resolve the tag from the active app language and the
 * device's locales at start. An empty persisted string is the serialized
 * form of `null`, so it parses back to the default.
 */
const languageStore = createSecureStorePreference<string | null>({
  key: VOICE_INPUT_LANGUAGE_KEY,
  defaultValue: null,
  parse: raw => (raw === null || raw.trim() === '' ? null : raw),
  serialize: value => value ?? '',
});

// Warm the disk read at module scope so the settings row and the first toggle
// see the persisted choice without waiting for a React mount.
languageStore.preload();

export function readVoiceInputLanguage(): string | null {
  return languageStore.get();
}

export function writeVoiceInputLanguage(tag: string | null): void {
  languageStore.set(tag);
}

/** Settings UI binding for the chosen voice-input language. */
export function useVoiceInputLanguage(): string | null {
  return useSyncExternalStore(languageStore.subscribe, languageStore.get);
}

/** Whether the stored language choice has finished its SecureStore read. */
export function useVoiceInputLanguageLoaded(): boolean {
  return useSyncExternalStore(languageStore.subscribe, languageStore.getHasLoaded);
}

/** Await the persisted language read. For callers with no React tree. */
export async function whenVoiceInputLanguageLoaded(): Promise<void> {
  await languageStore.whenLoaded();
}
