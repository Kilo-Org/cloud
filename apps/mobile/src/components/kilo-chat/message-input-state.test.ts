import { describe, expect, it } from 'vitest';
import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

import {
  applyMessageInputTextChange,
  shouldClearSubmittedDraft,
  shouldShowMessageInputCounter,
  submitMessageInputDraft,
} from './message-input-state';

describe('message input typing behavior', () => {
  it('sends typing notifications on text changes without preventing normal send', () => {
    const valueRef = { current: '' };
    const canSendValues: boolean[] = [];
    const sentMessages: { text: string; replyTo?: string }[] = [];
    let cleared = false;
    let typingCount = 0;

    applyMessageInputTextChange({
      text: '  hello  ',
      valueRef,
      setCanSend: canSend => {
        canSendValues.push(canSend);
      },
      onTyping: () => {
        typingCount += 1;
      },
    });

    const submitted = submitMessageInputDraft({
      valueRef,
      replyingToMessageId: 'reply-1',
      onSend: (text, replyTo) => {
        sentMessages.push({ text, replyTo });
      },
      clearInput: () => {
        cleared = true;
      },
      setCanSend: canSend => {
        canSendValues.push(canSend);
      },
    });

    expect(typingCount).toBe(1);
    expect(submitted).toEqual({ text: 'hello', replyingToMessageId: 'reply-1' });
    expect(sentMessages).toEqual([{ text: 'hello', replyTo: 'reply-1' }]);
    expect(cleared).toBe(false);
    expect(valueRef.current).toBe('  hello  ');
    expect(canSendValues).toEqual([true]);
  });

  it('keeps over-limit drafts intact and does not submit them', () => {
    const overLimitText = 'x'.repeat(MESSAGE_TEXT_MAX_CHARS + 1);
    const valueRef = { current: '' };
    const canSendValues: boolean[] = [];
    const sentMessages: string[] = [];
    let cleared = false;

    applyMessageInputTextChange({
      text: overLimitText,
      valueRef,
      setCanSend: canSend => {
        canSendValues.push(canSend);
      },
    });

    const submitted = submitMessageInputDraft({
      valueRef,
      onSend: text => {
        sentMessages.push(text);
      },
      clearInput: () => {
        cleared = true;
      },
      setCanSend: canSend => {
        canSendValues.push(canSend);
      },
    });

    expect(submitted).toBeNull();
    expect(sentMessages).toEqual([]);
    expect(cleared).toBe(false);
    expect(valueRef.current).toBe(overLimitText);
    expect(canSendValues).toEqual([false]);
  });

  it('leaves edit drafts intact when the caller controls clearing', () => {
    const valueRef = { current: '  edited draft  ' };
    const canSendValues: boolean[] = [];
    const sentMessages: string[] = [];
    let cleared = false;

    const submitted = submitMessageInputDraft({
      valueRef,
      onSend: text => {
        sentMessages.push(text);
      },
      clearInput: () => {
        cleared = true;
      },
      setCanSend: canSend => {
        canSendValues.push(canSend);
      },
      clearOnSubmit: false,
    });

    expect(submitted).toEqual({ text: 'edited draft', replyingToMessageId: undefined });
    expect(sentMessages).toEqual(['edited draft']);
    expect(cleared).toBe(false);
    expect(valueRef.current).toBe('  edited draft  ');
    expect(canSendValues).toEqual([]);
  });

  it('lets edit callers clear drafts after successful mutation', () => {
    const valueRef = { current: '  edited draft  ' };
    const canSendValues: boolean[] = [];
    const successControls: { clearDraft?: () => boolean } = {};
    let cleared = false;

    const submitted = submitMessageInputDraft({
      valueRef,
      onSend: (_text, _replyTo, controls) => {
        if (!controls) {
          throw new Error('expected submit controls');
        }
        successControls.clearDraft = controls.clearDraft;
      },
      clearInput: () => {
        cleared = true;
      },
      setCanSend: canSend => {
        canSendValues.push(canSend);
      },
      clearOnSubmit: false,
    });

    const clearDraft = successControls.clearDraft;
    if (!clearDraft) {
      throw new Error('expected submit controls');
    }
    clearDraft();

    expect(submitted).toEqual({ text: 'edited draft', replyingToMessageId: undefined });
    expect(cleared).toBe(true);
    expect(valueRef.current).toBe('');
    expect(canSendValues).toEqual([false]);
  });

  it('shows the character counter at eighty percent of the text limit', () => {
    expect(shouldShowMessageInputCounter('x'.repeat(MESSAGE_TEXT_MAX_CHARS * 0.8 - 1))).toBe(false);
    expect(shouldShowMessageInputCounter('x'.repeat(MESSAGE_TEXT_MAX_CHARS * 0.8))).toBe(true);
  });

  it('clears a submitted draft only when the visible draft and reply target still match', () => {
    const submitted = { text: 'hello', replyingToMessageId: 'reply-1' };

    expect(
      shouldClearSubmittedDraft({
        currentText: 'hello',
        currentReplyingToMessageId: 'reply-1',
        submitted,
      })
    ).toBe(true);

    expect(
      shouldClearSubmittedDraft({
        currentText: 'hello again',
        currentReplyingToMessageId: 'reply-1',
        submitted,
      })
    ).toBe(false);

    expect(
      shouldClearSubmittedDraft({
        currentText: 'hello',
        currentReplyingToMessageId: undefined,
        submitted,
      })
    ).toBe(false);
  });
});
