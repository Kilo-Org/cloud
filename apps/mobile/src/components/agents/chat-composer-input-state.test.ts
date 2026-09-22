import { describe, expect, it } from 'vitest';

import { resolveChatComposerControlState } from './chat-composer-input-state';

// Every test starts from a writable idle composer and overrides only the field
// under test, so each case names the inputs that matter to its assertion.
const baseInput = {
  attachmentsCount: 0,
  sendableAttachmentsCount: 0,
  attachmentMax: 5,
  disabled: false,
  hasText: false,
  isFocused: false,
  isSending: false,
  isUploading: false,
  hasFailedAttachments: false,
  voiceInputActive: false,
};

describe('resolveChatComposerControlState', () => {
  it('disables nothing and allows sending when idle with text and no voice session', () => {
    const state = resolveChatComposerControlState({ ...baseInput, hasText: true });

    expect(state).toEqual({
      canSend: true,
      hasSendableContent: true,
      inputEditable: true,
      inputAccessibilityDisabled: false,
      paperclipDisabled: false,
      showToolbar: true,
      toolbarDisabled: false,
      voiceDisabled: false,
    });
  });

  it('collapses send, voice, and toolbar when disabled or sending', () => {
    for (const override of [
      { disabled: true, isSending: false },
      { disabled: false, isSending: true },
    ]) {
      const state = resolveChatComposerControlState({ ...baseInput, ...override, hasText: true });

      expect(state.canSend).toBe(false);
      expect(state.hasSendableContent).toBe(true);
      expect(state.toolbarDisabled).toBe(true);
      expect(state.voiceDisabled).toBe(true);
      expect(state.inputEditable).toBe(false);
      expect(state.inputAccessibilityDisabled).toBe(true);
    }
  });

  it('keeps the input editable and gates send while the session cannot send', () => {
    const state = resolveChatComposerControlState({
      ...baseInput,
      sendDisabled: true,
      hasText: true,
    });

    // The reader types the next message beside the error's Retry; sending and
    // the toolbar wait for the session to recover.
    expect([state.inputEditable, state.inputAccessibilityDisabled]).toEqual([true, false]);
    expect(state.hasSendableContent).toBe(true);
    expect([state.canSend, state.toolbarDisabled, state.voiceDisabled]).toEqual([
      false,
      true,
      true,
    ]);
    expect(state.paperclipDisabled).toBe(true);
  });

  it('keeps the input editable and toolbar enabled while streaming when text is present', () => {
    const state = resolveChatComposerControlState({ ...baseInput, hasText: true });

    expect(state.inputEditable).toBe(true);
    expect(state.inputAccessibilityDisabled).toBe(false);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.voiceDisabled).toBe(false);
    expect(state.canSend).toBe(true);
    expect(state.hasSendableContent).toBe(true);
  });

  it('keeps the input editable while streaming with an empty draft (canSend stays false)', () => {
    const state = resolveChatComposerControlState(baseInput);

    expect(state.inputEditable).toBe(true);
    expect(state.inputAccessibilityDisabled).toBe(false);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(false);
  });

  it('still blocks send mid-stream when the parent disabled flag is on (e.g. read-only or capability gate)', () => {
    const state = resolveChatComposerControlState({ ...baseInput, disabled: true, hasText: true });

    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(true);
    expect(state.inputEditable).toBe(false);
    expect(state.toolbarDisabled).toBe(true);
  });

  it('does not allow send when the draft is empty and no attachment is ready', () => {
    const state = resolveChatComposerControlState({ ...baseInput, attachmentsCount: 2 });

    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(false);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.showToolbar).toBe(true);
  });

  it('allows send when the draft is empty and at least one attachment is ready', () => {
    const state = resolveChatComposerControlState({
      ...baseInput,
      attachmentsCount: 1,
      sendableAttachmentsCount: 1,
    });

    expect(state.canSend).toBe(true);
    expect(state.hasSendableContent).toBe(true);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.showToolbar).toBe(true);
  });

  it('allows send with text and no attachments', () => {
    const state = resolveChatComposerControlState({ ...baseInput, hasText: true });

    expect(state.canSend).toBe(true);
    expect(state.hasSendableContent).toBe(true);
  });

  it('blocks send while an upload is in flight, even with text and sendable attachments', () => {
    const state = resolveChatComposerControlState({
      ...baseInput,
      attachmentsCount: 1,
      sendableAttachmentsCount: 1,
      hasText: true,
      isUploading: true,
    });

    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(true);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.inputEditable).toBe(true);
  });

  it('gates send on a failed attachment chip while sendable content remains', () => {
    const state = resolveChatComposerControlState({
      ...baseInput,
      attachmentsCount: 1,
      sendableAttachmentsCount: 1,
      hasText: true,
      hasFailedAttachments: true,
    });

    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(true);
  });

  it('keeps the toolbar visible when focused, has text, has attachments, or voice is active', () => {
    expect(resolveChatComposerControlState({ ...baseInput, isFocused: true }).showToolbar).toBe(
      true
    );
    expect(resolveChatComposerControlState({ ...baseInput, hasText: true }).showToolbar).toBe(true);
    expect(resolveChatComposerControlState({ ...baseInput, attachmentsCount: 1 }).showToolbar).toBe(
      true
    );
    expect(
      resolveChatComposerControlState({ ...baseInput, voiceInputActive: true }).showToolbar
    ).toBe(true);
    expect(resolveChatComposerControlState(baseInput).showToolbar).toBe(false);
  });

  it('disables the paperclip when at or above the attachment cap', () => {
    const state = resolveChatComposerControlState({
      ...baseInput,
      attachmentsCount: 5,
      sendableAttachmentsCount: 5,
      hasText: true,
    });

    expect(state.paperclipDisabled).toBe(true);
  });

  it('disables the paperclip while the composer is in a toolbar-disabled state', () => {
    const state = resolveChatComposerControlState({ ...baseInput, isSending: true, hasText: true });

    expect(state.paperclipDisabled).toBe(true);
  });

  it('disables the paperclip but keeps the input editable while this owner is voice active', () => {
    const state = resolveChatComposerControlState({
      ...baseInput,
      voiceInputActive: true,
      hasText: true,
    });

    expect(state.paperclipDisabled).toBe(true);
    expect(state.inputEditable).toBe(true);
    expect(state.inputAccessibilityDisabled).toBe(false);
  });

  it('leaves voice enabled (only toolbar gates it) when the composer is otherwise ready', () => {
    const state = resolveChatComposerControlState(baseInput);

    expect(state.voiceDisabled).toBe(false);
  });
});
