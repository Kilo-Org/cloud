import { RTL_LANGUAGES, type SupportedLanguage } from '@/i18n/languages';
import {
  deleteStoredValueSafe,
  readStoredValueSafe,
  writeStoredValueSafe,
} from '@/lib/auth/secure-store-value';
import { LANGUAGE_DIRECTION_ATTEMPT_KEY } from '@/lib/storage-keys';

export type DirectionReloadDecision = 'in-sync' | 'reload' | 'give-up';

/**
 * Identifies one language's layout direction, the unit a reload attempt is
 * spent on: switching to a different language, or to the same language after
 * its direction changed, needs a fresh attempt.
 */
export function directionAttemptId(language: SupportedLanguage): string {
  return `${language}:${RTL_LANGUAGES.has(language) ? 'rtl' : 'ltr'}`;
}

/**
 * Decide what a cold start does with the native layout direction.
 *
 * A direction the app persisted only reaches the native side through the
 * preference file the previous React instance wrote, so a start that reads a
 * different direction forces it and reloads once. Reloading is spent on that
 * exact attempt id: if the next start reads the same mismatch, the persisted
 * direction never took effect (a dependency rewrote the preference, or the
 * platform refused it) and another reload would only repeat itself. The caller
 * surfaces that case instead, and pressing Retry spends a new attempt.
 */
export function resolveDirectionReload(input: {
  nativeIsRtl: boolean;
  targetIsRtl: boolean;
  attemptId: string;
  previousAttempt: string | null;
}): DirectionReloadDecision {
  if (input.nativeIsRtl === input.targetIsRtl) {
    return 'in-sync';
  }
  return input.previousAttempt === input.attemptId ? 'give-up' : 'reload';
}

/** The attempt recorded before the last direction reload, if any. Best-effort:
 *  an unreadable keychain reads as "no attempt spent". */
export function readDirectionReloadAttempt(): Promise<string | null> {
  return readStoredValueSafe(LANGUAGE_DIRECTION_ATTEMPT_KEY);
}

/** Record the attempt before reloading. Best-effort: a failed write costs one
 *  extra reload on the next start, never the direction itself. */
export async function writeDirectionReloadAttempt(attemptId: string): Promise<void> {
  await writeStoredValueSafe(LANGUAGE_DIRECTION_ATTEMPT_KEY, attemptId);
}

/** Drop the marker once the native direction matches, so the next change gets
 *  a fresh attempt. Best-effort: a marker left behind is ignored while the
 *  directions match. */
export async function clearDirectionReloadAttempt(): Promise<void> {
  await deleteStoredValueSafe(LANGUAGE_DIRECTION_ATTEMPT_KEY);
}