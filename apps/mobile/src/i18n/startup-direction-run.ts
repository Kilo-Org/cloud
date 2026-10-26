import { type SupportedLanguage } from './languages';
import { resolveLanguageStartupStep } from './startup-direction';

/**
 * What the cold start must do once the direction step has run.
 *
 * - `applied`: the running direction already matches, so the catalog loads in
 *   place.
 * - `reloaded`: `reload` returned instead of tearing the context down, so the
 *   caller must stop before first paint.
 * - `retry`: the direction could not be applied, so the caller shows the retry
 *   screen instead of first-painting in the wrong direction.
 */
export type LanguageStartupOutcome = 'applied' | 'reloaded' | 'retry';

/** The side effects the cold start's direction step needs. */
export type LanguageStartupDeps = Readonly<{
  syncRtl: (language: SupportedLanguage) => boolean;
  readAttempt: () => Promise<SupportedLanguage | null>;
  writeAttempt: (language: SupportedLanguage) => Promise<boolean>;
  clearAttempt: () => Promise<void>;
  reload: () => Promise<void>;
}>;

/**
 * Run the cold start's direction step for the stored language.
 *
 * The step decides between the three cases `resolveLanguageStartupStep` names,
 * and this runs the effects: the attempt record is dropped once the direction
 * matches, written before a relaunch, and a missing record refuses the
 * relaunch, because a relaunch that does not take the direction would repeat on
 * every launch and leave the app on a blank frame.
 */
export async function runLanguageStartupDirectionAsync(
  input: Readonly<{
    language: SupportedLanguage;
    /** The direction the running app reports. */
    isRtl: boolean;
    /** The direction the resolved language needs. */
    shouldBeRtl: boolean;
  }>,
  deps: LanguageStartupDeps
): Promise<LanguageStartupOutcome> {
  const step = resolveLanguageStartupStep({
    isRtl: input.isRtl,
    shouldBeRtl: input.shouldBeRtl,
    language: input.language,
    lastAttempt: await deps.readAttempt(),
  });

  if (step === 'apply') {
    // The record has done its job: a later change back to the other direction
    // may relaunch again.
    void deps.clearAttempt();
    return 'applied';
  }
  if (step === 'fallback') {
    // The previous launch relaunched for this very direction and the platform
    // came back with the other one, so relaunching again would loop.
    return 'retry';
  }
  if (!(await deps.writeAttempt(input.language))) {
    // Without the record the next cold start cannot tell that the direction was
    // already attempted, so keep the current direction and let the user retry.
    return 'retry';
  }
  deps.syncRtl(input.language);
  try {
    await deps.reload();
  } catch {
    return 'retry';
  }
  return 'reloaded';
}

/**
 * Run the retry control of the language retry screen.
 *
 * A retry is the user asking for another attempt, not the automatic relaunch
 * the record guards against, so the record is dropped before the reload: a
 * reload that ran first would come back to the same refused launch and show
 * this screen again. `false` when the reload failed and the screen stays.
 */
export async function retryLanguageStartupDirectionAsync(
  deps: Readonly<{ clearAttempt: () => Promise<void>; reload: () => Promise<void> }>
): Promise<boolean> {
  await deps.clearAttempt();
  try {
    await deps.reload();
    return true;
  } catch {
    return false;
  }
}
