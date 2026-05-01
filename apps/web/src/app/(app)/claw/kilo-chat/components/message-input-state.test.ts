import { MESSAGE_TEXT_MAX_CHARS } from '@kilocode/kilo-chat';

import { canSubmitMessageInput } from './MessageInput';

describe('canSubmitMessageInput', () => {
  it('waits for the current user id before allowing submit', () => {
    expect(canSubmitMessageInput(null, true, false, 'hello')).toBe(false);
    expect(canSubmitMessageInput('user-1', true, false, 'hello')).toBe(true);
  });

  it('blocks unavailable, empty, and over-limit sends', () => {
    expect(canSubmitMessageInput('user-1', false, false, 'hello')).toBe(false);
    expect(canSubmitMessageInput('user-1', true, false, '   ')).toBe(false);
    expect(
      canSubmitMessageInput('user-1', true, true, 'x'.repeat(MESSAGE_TEXT_MAX_CHARS + 1))
    ).toBe(false);
  });
});
