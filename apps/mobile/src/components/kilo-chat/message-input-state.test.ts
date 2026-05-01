import { describe, expect, it } from 'vitest';
import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

import { applyMessageInputTextChange, submitMessageInputDraft } from './message-input-state';

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
    expect(submitted).toBe(true);
    expect(sentMessages).toEqual([{ text: 'hello', replyTo: 'reply-1' }]);
    expect(cleared).toBe(true);
    expect(valueRef.current).toBe('');
    expect(canSendValues).toEqual([true, false]);
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

    expect(submitted).toBe(false);
    expect(sentMessages).toEqual([]);
    expect(cleared).toBe(false);
    expect(valueRef.current).toBe(overLimitText);
    expect(canSendValues).toEqual([false]);
  });
});
