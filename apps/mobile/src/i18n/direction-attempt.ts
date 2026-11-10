import {
  deleteStoredValueSafe,
  readStoredValueSafe,
  writeStoredValueSafe,
} from '@/lib/auth/secure-store-value';
import { LANGUAGE_DIRECTION_ATTEMPT_KEY } from '@/lib/storage-keys';

import { isSupportedLanguage, type SupportedLanguage } from './languages';

/**
 * The language whose forced native direction the last launch relaunched for.
 *
 * Recorded before a direction relaunch and cleared once the direction matches,
 * so a forced direction that never takes effect reloads the app at most once
 * instead of on every launch. Never rejects: a read failure only costs the
 * caller the loop protection, and a write failure keeps it from relaunching.
 */
export async function readDirectionAttemptAsync(): Promise<SupportedLanguage | null> {
  const raw = await readStoredValueSafe(LANGUAGE_DIRECTION_ATTEMPT_KEY);
  return raw !== null && isSupportedLanguage(raw) ? raw : null;
}

/** Record the direction relaunch. `false` when the record could not be written. */
export function writeDirectionAttemptAsync(language: SupportedLanguage): Promise<boolean> {
  return writeStoredValueSafe(LANGUAGE_DIRECTION_ATTEMPT_KEY, language);
}

export async function clearDirectionAttemptAsync(): Promise<void> {
  await deleteStoredValueSafe(LANGUAGE_DIRECTION_ATTEMPT_KEY);
}
