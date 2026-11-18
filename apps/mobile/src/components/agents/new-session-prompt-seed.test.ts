import { describe, expect, it } from 'vitest';

import {
  type NewSessionPromptSeedInput,
  resolveNewSessionPromptSeedDecision,
} from './new-session-prompt-seed';

function decide(overrides: Partial<NewSessionPromptSeedInput> = {}) {
  return resolveNewSessionPromptSeedDecision({
    draftSettled: true,
    seed: 'pending',
    prompt: '',
    initialPrompt: undefined,
    sharePrefillText: null,
    userEdited: false,
    ...overrides,
  });
}

describe('resolveNewSessionPromptSeedDecision', () => {
  it('keeps waiting while the draft load has not settled', () => {
    expect(decide({ draftSettled: false })).toEqual({ type: 'keep' });
  });

  it('settles in place instead of restoring a stored draft when the user cleared a pre-identity prompt', () => {
    // Type, clear, then the identity resolves with an older saved draft: the
    // explicit clear must win over the stored draft.
    expect(
      decide({
        prompt: '',
        initialPrompt: 'older saved draft',
        userEdited: true,
      })
    ).toEqual({ type: 'settle' });
  });

  it('restores the stored draft when the user never edited the prompt', () => {
    expect(
      decide({
        prompt: '',
        initialPrompt: 'older saved draft',
      })
    ).toEqual({
      type: 'restore',
      prompt: 'older saved draft',
      hasPrompt: true,
      seed: 'restore',
    });
  });

  it('settles when the user typed before the identity resolved', () => {
    expect(
      decide({
        prompt: 'typed before identity',
        initialPrompt: 'older saved draft',
        userEdited: true,
      })
    ).toEqual({ type: 'settle' });
  });

  it('does not remount for a share prefill that already seeded the first render', () => {
    expect(
      decide({
        initialPrompt: 'shared text',
        sharePrefillText: 'shared text',
      })
    ).toEqual({
      type: 'restore',
      prompt: 'shared text',
      hasPrompt: true,
      seed: 'settled',
    });
  });

  it('settles when there is no stored draft to restore', () => {
    expect(decide({ initialPrompt: undefined })).toEqual({ type: 'settle' });
  });

  it('preserves a settled non-empty prompt across an identity change', () => {
    expect(decide({ draftSettled: false, seed: 'settled', prompt: 'typed' })).toEqual({
      type: 'keep',
    });
  });

  it('resets a restored draft when the identity changes', () => {
    expect(decide({ draftSettled: false, seed: 'restore', prompt: 'stored draft' })).toEqual({
      type: 'reset',
    });
  });

  it('leaves an already settled seed untouched', () => {
    expect(decide({ seed: 'settled' })).toEqual({ type: 'keep' });
  });
});
