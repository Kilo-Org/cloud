import { shouldApplyConversationRead } from './conversation-read-events';

describe('shouldApplyConversationRead', () => {
  it('waits for the current user id before applying own read events', () => {
    expect(shouldApplyConversationRead('', 'user-1')).toBe(false);
    expect(shouldApplyConversationRead('user-1', 'user-1')).toBe(true);
    expect(shouldApplyConversationRead('user-1', 'user-2')).toBe(false);
  });
});
