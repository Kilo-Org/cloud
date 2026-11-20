import * as SecureStore from '@/lib/auth/secure-store';

import { LANGUAGE_RETURN_TARGET_KEY } from '@/lib/storage-keys';

export type LanguageReturnTarget = 'login' | 'profile' | 'preferences';

/**
 * One-shot return target written before an RTL reload so the relaunched app
 * can reopen the screen the user was on. The marker is read once and then
 * disarmed: a delete removes it, and a refused delete is replaced by an inert
 * value instead, so a later launch reads a marker that names no screen and
 * cannot act on the same target again. The target that was read is still
 * returned — the disarm happens after the read, and its failures never reach
 * the caller.
 */
export async function writeLanguageReturnTarget(target: LanguageReturnTarget): Promise<void> {
  await SecureStore.setItemAsync(LANGUAGE_RETURN_TARGET_KEY, target);
}

/** Matches no return target, so a launch that reads it navigates nowhere. */
const CONSUMED_TARGET = 'consumed';

function isLanguageReturnTarget(value: string | null): value is LanguageReturnTarget {
  return value === 'login' || value === 'profile' || value === 'preferences';
}

/**
 * Disarms the marker, and never rejects: a launch whose keychain refuses the
 * delete or the overwrite has nothing left to do about it, and the wrapper has
 * already reported each refusal. The caller's own read decides the outcome.
 */
async function consumeLanguageReturnTarget(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(LANGUAGE_RETURN_TARGET_KEY);
    return;
  } catch {
    // The overwrite below still disarms the marker.
  }
  try {
    await SecureStore.setItemAsync(LANGUAGE_RETURN_TARGET_KEY, CONSUMED_TARGET);
  } catch {
    // Both refusals are already reported by the wrapper.
  }
}

export async function readLanguageReturnTarget(): Promise<LanguageReturnTarget | null> {
  const raw = await SecureStore.getItemAsync(LANGUAGE_RETURN_TARGET_KEY);
  await consumeLanguageReturnTarget();
  return isLanguageReturnTarget(raw) ? raw : null;
}
