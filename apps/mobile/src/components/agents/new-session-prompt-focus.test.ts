import { describe, expect, it } from 'vitest';

import { shouldAutoFocusNewSessionPrompt } from './new-session-prompt-focus';

/**
 * The rule that keeps the keyboard from hiding the session configuration. The
 * cases are the entry shapes the screen produces, and they run through the same
 * composition the screen body calls, so a change to the prefill gate or the
 * share veto fails here instead of drifting unnoticed.
 */
const listed = [{ platform: 'github', fullName: 'acme/notes' } as const];

function decide(overrides: Partial<Parameters<typeof shouldAutoFocusNewSessionPrompt>[0]> = {}) {
  return shouldAutoFocusNewSessionPrompt({
    sharePrefilled: false,
    hasSelectedRepository: false,
    reposSettled: true,
    repositories: listed,
    prefill: { mode: 'code' },
    ...overrides,
  });
}

describe('shouldAutoFocusNewSessionPrompt', () => {
  it('keeps the keyboard down when the session still needs a repository', () => {
    // The reported state: the form is entered with nothing picked, and taking
    // focus would shrink the frame past the picker and the configuration.
    expect(decide()).toBe(false);
  });

  it('takes focus when a repository is already selected', () => {
    expect(decide({ hasSelectedRepository: true, reposSettled: false })).toBe(true);
  });

  it('takes focus when the prefilled repository is in the settled list', () => {
    expect(decide({ prefill: { mode: 'code', repo: 'acme/notes' } })).toBe(true);
  });

  it('keeps the keyboard down for a prefill that matches nothing', () => {
    // The repository was removed: the form is as unconfigured as the plain
    // entry, so focus must not hide the sections.
    expect(decide({ prefill: { mode: 'code', repo: 'acme/gone' } })).toBe(false);
  });

  it('keeps the keyboard down while any provider list is unsettled', () => {
    // `reposSettled` is false whenever a provider is still loading or errored,
    // even if another provider's cached list already names the repository: the
    // screen does not apply the prefill then, so neither does this decision.
    expect(decide({ reposSettled: false, prefill: { mode: 'code', repo: 'acme/notes' } })).toBe(
      false
    );
  });

  it('never takes focus for a share payload, even with a selected repository', () => {
    // A share payload prefills the composer: raising the keyboard would hide
    // the attachment strip and Start, which is why it vetoed focus before.
    expect(decide({ sharePrefilled: true, hasSelectedRepository: true })).toBe(false);
  });
});
