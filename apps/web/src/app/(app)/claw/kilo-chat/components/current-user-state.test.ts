import { createOptimisticMessage } from '@kilocode/kilo-chat-hooks';
import { currentUserIdFromUser } from './current-user-state';

describe('current kilo-chat user state', () => {
  it('represents an unloaded user as null', () => {
    expect(currentUserIdFromUser(undefined)).toBeNull();
    expect(currentUserIdFromUser({ id: 'user-1' })).toBe('user-1');
  });

  it('does not create an optimistic message before the user id is loaded', () => {
    const optimisticMessage = createOptimisticMessage(
      {
        conversationId: 'conversation-1',
        clientId: 'client-1',
        content: [{ type: 'text', text: 'hello' }],
      },
      null
    );

    expect(optimisticMessage).toBeNull();
  });
});
