import { describe, expect, it } from 'vitest';

import {
  MESSAGE_INPUT_BORDER_WIDTH,
  MESSAGE_INPUT_LINE_HEIGHT,
  MESSAGE_INPUT_MAX_HEIGHT,
  MESSAGE_INPUT_MAX_VISIBLE_LINES,
  MESSAGE_INPUT_MIN_HEIGHT,
  MESSAGE_INPUT_VERTICAL_INSET,
  messageInputKeyboardProps,
  messageInputTextStyle,
  resolveMessageInputBottomPadding,
  resolveMessageInputHeight,
  resolveMessageInputShouldScroll,
} from './message-input-layout';

describe('message input layout', () => {
  it('centers a single text line inside the bordered composer input', () => {
    const expectedPadding =
      (MESSAGE_INPUT_MIN_HEIGHT - MESSAGE_INPUT_LINE_HEIGHT - MESSAGE_INPUT_BORDER_WIDTH * 2) / 2;

    expect(messageInputTextStyle).toMatchObject({
      fontSize: 14,
      includeFontPadding: false,
      lineHeight: MESSAGE_INPUT_LINE_HEIGHT,
      paddingBottom: expectedPadding,
      paddingTop: expectedPadding,
      textAlignVertical: 'top',
    });
  });

  it('keeps composer bottom padding constant across safe-area insets', () => {
    expect(resolveMessageInputBottomPadding()).toBe(8);
  });

  it('caps the visible composer text area at five lines', () => {
    const expectedMaxHeight =
      MESSAGE_INPUT_LINE_HEIGHT * MESSAGE_INPUT_MAX_VISIBLE_LINES + MESSAGE_INPUT_VERTICAL_INSET;

    expect(MESSAGE_INPUT_MAX_VISIBLE_LINES).toBe(5);
    expect(MESSAGE_INPUT_MAX_HEIGHT).toBe(expectedMaxHeight);
    expect(messageInputTextStyle.maxHeight).toBe(expectedMaxHeight);
  });

  it('enables composer scrolling once measured input height reaches the visible line cap', () => {
    expect(resolveMessageInputShouldScroll(MESSAGE_INPUT_MAX_HEIGHT - 1)).toBe(false);
    expect(resolveMessageInputShouldScroll(MESSAGE_INPUT_MAX_HEIGHT)).toBe(true);
    expect(resolveMessageInputShouldScroll(MESSAGE_INPUT_MAX_HEIGHT + 1)).toBe(true);
  });

  it('grows the composer height from measured wrapped text up to the visible line cap', () => {
    const twoLineContentHeight = MESSAGE_INPUT_LINE_HEIGHT * 2;

    expect(resolveMessageInputHeight(0)).toBe(MESSAGE_INPUT_MIN_HEIGHT);
    expect(resolveMessageInputHeight(twoLineContentHeight)).toBe(
      twoLineContentHeight + MESSAGE_INPUT_VERTICAL_INSET
    );
    expect(resolveMessageInputHeight(MESSAGE_INPUT_MAX_HEIGHT + MESSAGE_INPUT_LINE_HEIGHT)).toBe(
      MESSAGE_INPUT_MAX_HEIGHT
    );
  });

  it('uses a normal multiline keyboard return key instead of submitting from the keyboard', () => {
    expect(messageInputKeyboardProps).toMatchObject({
      keyboardType: 'default',
      returnKeyType: 'default',
      submitBehavior: 'newline',
    });
  });
});
