import { describe, expect, it } from 'vitest';

import { shouldAutoFocusNewSessionPrompt } from './new-session-prompt-focus';

/**
 * The decision that keeps the keyboard from hiding the session configuration.
 * The cases are the entry shapes the screen actually produces: a share
 * hand-off, the tour's computer path, a route prefill, an auto-selected recent
 * repository, and the plain entry from the Agents tab with nothing picked.
 */
describe('shouldAutoFocusNewSessionPrompt', () => {
  const plain = {
    sharePrefilled: false,
    hasSelectedRepository: false,
    hasRepositoryPrefill: false,
  };

  it('keeps the keyboard down when the session still needs a repository', () => {
    // The reported state: the form is entered with nothing picked, and taking
    // focus would shrink the frame past the picker and the configuration.
    expect(shouldAutoFocusNewSessionPrompt(plain)).toBe(false);
  });

  it('takes focus when a repository is already selected', () => {
    expect(shouldAutoFocusNewSessionPrompt({ ...plain, hasSelectedRepository: true })).toBe(true);
  });

  it('takes focus when the route carries a repository prefill', () => {
    expect(shouldAutoFocusNewSessionPrompt({ ...plain, hasRepositoryPrefill: true })).toBe(true);
  });

  it('never takes focus for a share payload, even with a selected repository', () => {
    // A share payload prefills the composer: raising the keyboard would hide
    // the attachment strip and Start, which is why it vetoed focus before.
    expect(
      shouldAutoFocusNewSessionPrompt({
        sharePrefilled: true,
        hasSelectedRepository: true,
        hasRepositoryPrefill: true,
      })
    ).toBe(false);
  });
});
