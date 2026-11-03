import { describe, expect, it } from 'vitest';

import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';

import {
  PROMPT_COUNTER_VISIBLE_REMAINING,
  resolveNewSessionPromptControlState,
  resolveNewSessionPromptForCreate,
  resolvePromptCounterRemaining,
} from './new-session-prompt-state';

describe('resolveNewSessionPromptForCreate', () => {
  it('returns the trimmed prompt when the live draft is non-empty', () => {
    expect(resolveNewSessionPromptForCreate('  build a feature  ')).toBe('build a feature');
  });

  it('preserves a single-token prompt that is already trimmed', () => {
    expect(resolveNewSessionPromptForCreate('/help')).toBe('/help');
  });

  it('returns null when the live draft is empty after settlement', () => {
    expect(resolveNewSessionPromptForCreate('')).toBeNull();
  });

  it('returns null when the live draft is whitespace-only after settlement', () => {
    expect(resolveNewSessionPromptForCreate('   \n\t  ')).toBeNull();
  });
});

describe('resolveNewSessionPromptControlState', () => {
  it('treats trimmed text as the prompt and reports hasPrompt only when non-empty', () => {
    expect(
      resolveNewSessionPromptControlState({
        attachmentsCount: 0,
        attachmentMax: 5,
        isCreating: false,
        rawPrompt: '   ',
        voiceInputActive: false,
      }).hasPrompt
    ).toBe(false);

    expect(
      resolveNewSessionPromptControlState({
        attachmentsCount: 0,
        attachmentMax: 5,
        isCreating: false,
        rawPrompt: ' hello world ',
        voiceInputActive: false,
      }).hasPrompt
    ).toBe(true);
  });

  it('keeps the prompt empty in a no-create state even if everything else is ready', () => {
    const state = resolveNewSessionPromptControlState({
      attachmentsCount: 0,
      attachmentMax: 5,
      isCreating: false,
      rawPrompt: '',
      voiceInputActive: false,
    });

    expect(state.createDisabled).toBe(false);
    expect(state.hasPrompt).toBe(false);
  });

  it('locks create while in-flight (isCreating), regardless of prompt content', () => {
    const state = resolveNewSessionPromptControlState({
      attachmentsCount: 0,
      attachmentMax: 5,
      isCreating: true,
      rawPrompt: 'build a feature',
      voiceInputActive: false,
    });

    expect(state.createDisabled).toBe(true);
    // The draft-mutating controls stay locked: the create holds its snapshot.
    expect(state.draftMutationLocked).toBe(true);
    expect(state.voiceDisabled).toBe(true);
    expect(state.paperclipDisabled).toBe(true);
  });

  it('disables the paperclip while this owner is voice active', () => {
    const state = resolveNewSessionPromptControlState({
      attachmentsCount: 0,
      attachmentMax: 5,
      isCreating: false,
      rawPrompt: 'halfway typed',
      voiceInputActive: true,
    });

    expect(state.paperclipDisabled).toBe(true);
    expect(state.voiceDisabled).toBe(false);
    expect(state.hasPrompt).toBe(true);
  });

  it('leaves voice enabled (only isCreating gates it) when otherwise idle with a prompt', () => {
    const state = resolveNewSessionPromptControlState({
      attachmentsCount: 0,
      attachmentMax: 5,
      isCreating: false,
      rawPrompt: 'design a screen',
      voiceInputActive: false,
    });

    expect(state.voiceDisabled).toBe(false);
    expect(state.draftMutationLocked).toBe(false);
    expect(state.paperclipDisabled).toBe(false);
    expect(state.createDisabled).toBe(false);
  });

  it('disables the paperclip at or above the attachment cap', () => {
    const state = resolveNewSessionPromptControlState({
      attachmentsCount: 5,
      attachmentMax: 5,
      isCreating: false,
      rawPrompt: 'plan the rollout',
      voiceInputActive: false,
    });

    expect(state.paperclipDisabled).toBe(true);
  });
});

describe('resolvePromptCounterRemaining', () => {
  it('stays hidden for the whole draft range that never nears the limit', () => {
    // The counter is the only thing the prompt card renders from the draft's
    // length, so this range has to reproject to nothing: a composer that
    // republished the raw length re-rendered its card — toolbar, attachment
    // strip, controls, voice surface — on every one of these keystrokes.
    const hiddenThrough = CLOUD_AGENT_PROMPT_MAX_LENGTH - PROMPT_COUNTER_VISIBLE_REMAINING - 1;
    // The whole range, not a sample of it: every length below the threshold is
    // one a keystroke can land on, and each has to reproject to nothing.
    for (let length = 0; length <= hiddenThrough; length += 1) {
      expect(resolvePromptCounterRemaining(length)).toBeNull();
    }
    // The first length that shows the counter, so the range above cannot pass by
    // being empty.
    expect(resolvePromptCounterRemaining(hiddenThrough + 1)).toBe(PROMPT_COUNTER_VISIBLE_REMAINING);
  });

  it('counts down the remaining characters once the draft nears the limit', () => {
    const atLimit = CLOUD_AGENT_PROMPT_MAX_LENGTH - PROMPT_COUNTER_VISIBLE_REMAINING;
    expect(resolvePromptCounterRemaining(atLimit)).toBe(PROMPT_COUNTER_VISIBLE_REMAINING);
    expect(resolvePromptCounterRemaining(atLimit + 1)).toBe(PROMPT_COUNTER_VISIBLE_REMAINING - 1);
    expect(resolvePromptCounterRemaining(CLOUD_AGENT_PROMPT_MAX_LENGTH)).toBe(0);
  });

  it('reports the overshoot rather than clamping a paste past the limit', () => {
    expect(resolvePromptCounterRemaining(CLOUD_AGENT_PROMPT_MAX_LENGTH + 25)).toBe(-25);
  });
});
