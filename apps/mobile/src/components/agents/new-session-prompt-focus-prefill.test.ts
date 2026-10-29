import { describe, expect, it } from 'vitest';

import { resolvePrefillRepoSelection } from './new-session-prefill';
import { shouldAutoFocusNewSessionPrompt } from './new-session-prompt-focus';

/**
 * The prompt only takes focus on arrival when the form is genuinely configured.
 * `isPrefillResolved` is the body's rule: a route prefill counts only once the
 * loaded list contains that repository, which is what a stale prefill (the
 * repository was removed, or its provider list failed) does not.
 */
function isPrefillResolved(
  repositories: { platform: string; fullName: string }[],
  repo: string | undefined
): boolean {
  return resolvePrefillRepoSelection(repositories, { mode: 'code', repo }) !== null;
}

const listed = [{ platform: 'github', fullName: 'acme/notes' }];

describe('prefill focus gate', () => {
  it('takes focus when the prefilled repository is in the list', () => {
    expect(
      shouldAutoFocusNewSessionPrompt({
        sharePrefilled: false,
        hasSelectedRepository: false,
        hasRepositoryPrefill: isPrefillResolved(listed, 'acme/notes'),
      })
    ).toBe(true);
  });

  it('keeps the keyboard down for a prefill that matches nothing', () => {
    // The repository was removed, or its provider list failed: the form is as
    // unconfigured as the plain entry, so focus must not hide the sections.
    expect(
      shouldAutoFocusNewSessionPrompt({
        sharePrefilled: false,
        hasSelectedRepository: false,
        hasRepositoryPrefill: isPrefillResolved(listed, 'acme/gone'),
      })
    ).toBe(false);
  });

  it('keeps the keyboard down before the repository list has loaded', () => {
    expect(
      shouldAutoFocusNewSessionPrompt({
        sharePrefilled: false,
        hasSelectedRepository: false,
        hasRepositoryPrefill: isPrefillResolved([], 'acme/notes'),
      })
    ).toBe(false);
  });
});
