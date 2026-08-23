import * as SecureStore from 'expo-secure-store';

import { LANGUAGE_RETURN_TARGET_KEY } from '@/lib/storage-keys';

export type LanguageReturnTarget = 'login' | 'profile';

/**
 * One-shot return target written before an RTL reload so the relaunched app
 * can reopen the screen the user was on. Read once, then deleted.
 */
export async function writeLanguageReturnTarget(target: LanguageReturnTarget): Promise<void> {
  await SecureStore.setItemAsync(LANGUAGE_RETURN_TARGET_KEY, target);
}

export async function readLanguageReturnTarget(): Promise<LanguageReturnTarget | null> {
  const raw = await SecureStore.getItemAsync(LANGUAGE_RETURN_TARGET_KEY);
  await SecureStore.deleteItemAsync(LANGUAGE_RETURN_TARGET_KEY);
  if (raw === 'login' || raw === 'profile') {
    return raw;
  }
  return null;
}
