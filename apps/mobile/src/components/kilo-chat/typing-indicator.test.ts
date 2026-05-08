import { describe, expect, it } from 'vitest';

import { formatTypingIndicatorText } from './typing-indicator-text';

describe('typing indicator text', () => {
  it('uses the active bot name for bot typing events', () => {
    expect(
      formatTypingIndicatorText({
        botName: 'Production Bot',
        typingMemberIds: ['bot:sandbox-1'],
      })
    ).toBe('Production Bot is typing...');
  });

  it('returns null when nobody is typing', () => {
    expect(
      formatTypingIndicatorText({ botName: 'Production Bot', typingMemberIds: [] })
    ).toBeNull();
  });
});
