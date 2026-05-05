import { describe, expect, it } from 'vitest';

import {
  MESSAGE_INPUT_BORDER_WIDTH,
  MESSAGE_INPUT_LINE_HEIGHT,
  MESSAGE_INPUT_MIN_HEIGHT,
  messageInputTextStyle,
  resolveMessageInputBottomPadding,
} from './message-input-layout';

describe('message input layout', () => {
  it('centers a single text line inside the bordered composer input', () => {
    const expectedPadding =
      (MESSAGE_INPUT_MIN_HEIGHT - MESSAGE_INPUT_LINE_HEIGHT - MESSAGE_INPUT_BORDER_WIDTH * 2) / 2;

    expect(messageInputTextStyle).toMatchObject({
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
});
