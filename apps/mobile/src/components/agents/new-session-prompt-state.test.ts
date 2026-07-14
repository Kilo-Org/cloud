import { describe, expect, it } from 'vitest';

import {
  resolveNewSessionPromptControlState,
  resolveNewSessionPromptForCreate,
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
    expect(state.inputEditable).toBe(false);
    expect(state.inputAccessibilityDisabled).toBe(true);
    expect(state.voiceDisabled).toBe(true);
    expect(state.paperclipDisabled).toBe(true);
  });

  it('disables the text input and paperclip while this owner is voice active', () => {
    const state = resolveNewSessionPromptControlState({
      attachmentsCount: 0,
      attachmentMax: 5,
      isCreating: false,
      rawPrompt: 'halfway typed',
      voiceInputActive: true,
    });

    expect(state.inputEditable).toBe(false);
    expect(state.inputAccessibilityDisabled).toBe(true);
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
    expect(state.inputEditable).toBe(true);
    expect(state.inputAccessibilityDisabled).toBe(false);
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
