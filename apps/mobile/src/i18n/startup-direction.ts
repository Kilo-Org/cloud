import { type SupportedLanguage } from './languages';

/**
 * What a cold start does about the native layout direction.
 *
 * - `apply`: the native direction already matches the resolved language, so the
 *   catalog is applied in place.
 * - `reload`: the direction is forced and the app relaunches once.
 * - `fallback`: the direction was already forced for this language on a
 *   previous launch and still does not match, so the app must not relaunch
 *   again. The caller shows the retry screen instead of reloading forever.
 */
export type LanguageStartupStep = 'apply' | 'fallback' | 'reload';

/**
 * Decide the cold start's direction step.
 *
 * A relaunch is the only way to apply a forced direction, and the forced
 * direction is not guaranteed to survive it: the platform can come back with
 * the direction it had before. Reloading on every launch in that case leaves
 * the app in a permanent relaunch loop on a blank frame, so the attempt is
 * recorded and a second attempt for the same language is refused.
 */
export function resolveLanguageStartupStep(
  input: Readonly<{
    /** The direction the running app reports. */
    isRtl: boolean;
    /** The direction the resolved language needs. */
    shouldBeRtl: boolean;
    language: SupportedLanguage;
    /** The language whose forced direction the previous launch relaunched for. */
    lastAttempt: SupportedLanguage | null;
  }>
): LanguageStartupStep {
  if (input.isRtl === input.shouldBeRtl) {
    return 'apply';
  }
  return input.lastAttempt === input.language ? 'fallback' : 'reload';
}
