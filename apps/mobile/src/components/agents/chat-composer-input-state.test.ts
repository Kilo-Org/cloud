import { describe, expect, it } from 'vitest';

import { resolveChatComposerControlState } from './chat-composer-input-state';

describe('resolveChatComposerControlState', () => {
  it('disables nothing and allows sending when idle with text and no voice session', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: true,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

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
      const state = resolveChatComposerControlState({
        attachmentsCount: 0,
        sendableAttachmentsCount: 0,
        attachmentMax: 5,
        disabled: override.disabled,
        hasText: true,
        isFocused: false,
        isSending: override.isSending,
        isUploading: false,
        voiceInputActive: false,
      });

      expect(state.canSend).toBe(false);
      expect(state.hasSendableContent).toBe(true);
      expect(state.toolbarDisabled).toBe(true);
      expect(state.voiceDisabled).toBe(true);
      expect(state.inputEditable).toBe(false);
      expect(state.inputAccessibilityDisabled).toBe(true);
    }
  });

  it('keeps the input editable and toolbar enabled while streaming when text is present', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: true,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.inputEditable).toBe(true);
    expect(state.inputAccessibilityDisabled).toBe(false);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.voiceDisabled).toBe(false);
    expect(state.canSend).toBe(true);
    expect(state.hasSendableContent).toBe(true);
  });

  it('keeps the input editable while streaming with an empty draft (canSend stays false)', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: false,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.inputEditable).toBe(true);
    expect(state.inputAccessibilityDisabled).toBe(false);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(false);
  });

  it('still blocks send mid-stream when the parent disabled flag is on (e.g. read-only or capability gate)', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: true,
      hasText: true,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(true);
    expect(state.inputEditable).toBe(false);
    expect(state.toolbarDisabled).toBe(true);
  });

  it('does not allow send when the draft is empty and no attachment is ready', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 2,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: false,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(false);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.showToolbar).toBe(true);
  });

  it('allows send when the draft is empty and at least one attachment is ready', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 1,
      sendableAttachmentsCount: 1,
      attachmentMax: 5,
      disabled: false,
      hasText: false,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.canSend).toBe(true);
    expect(state.hasSendableContent).toBe(true);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.showToolbar).toBe(true);
  });

  it('allows send with text and no attachments', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: true,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.canSend).toBe(true);
    expect(state.hasSendableContent).toBe(true);
  });

  it('blocks send while an upload is in flight, even with text and sendable attachments', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 1,
      sendableAttachmentsCount: 1,
      attachmentMax: 5,
      disabled: false,
      hasText: true,
      isFocused: false,
      isSending: false,
      isUploading: true,
      voiceInputActive: false,
    });

    expect(state.canSend).toBe(false);
    expect(state.hasSendableContent).toBe(true);
    expect(state.toolbarDisabled).toBe(false);
    expect(state.inputEditable).toBe(true);
  });

  it('keeps the toolbar visible when focused, has text, has attachments, or voice is active', () => {
    const base = {
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: false,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    };

    expect(resolveChatComposerControlState({ ...base, isFocused: true }).showToolbar).toBe(true);
    expect(resolveChatComposerControlState({ ...base, hasText: true }).showToolbar).toBe(true);
    expect(resolveChatComposerControlState({ ...base, attachmentsCount: 1 }).showToolbar).toBe(
      true
    );
    expect(resolveChatComposerControlState({ ...base, voiceInputActive: true }).showToolbar).toBe(
      true
    );
    expect(resolveChatComposerControlState(base).showToolbar).toBe(false);
  });

  it('disables the paperclip when at or above the attachment cap', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 5,
      sendableAttachmentsCount: 5,
      attachmentMax: 5,
      disabled: false,
      hasText: true,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.paperclipDisabled).toBe(true);
  });

  it('disables the paperclip while the composer is in a toolbar-disabled state', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: true,
      isFocused: false,
      isSending: true,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.paperclipDisabled).toBe(true);
  });

  it('disables the paperclip and input while this owner is voice active', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: true,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: true,
    });

    expect(state.paperclipDisabled).toBe(true);
    expect(state.inputEditable).toBe(false);
    expect(state.inputAccessibilityDisabled).toBe(true);
  });

  it('leaves voice enabled (only toolbar gates it) when the composer is otherwise ready', () => {
    const state = resolveChatComposerControlState({
      attachmentsCount: 0,
      sendableAttachmentsCount: 0,
      attachmentMax: 5,
      disabled: false,
      hasText: false,
      isFocused: false,
      isSending: false,
      isUploading: false,
      voiceInputActive: false,
    });

    expect(state.voiceDisabled).toBe(false);
  });
});
