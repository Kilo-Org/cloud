import { describe, expect, it, vi } from 'vitest';

import { pushInstanceEventToUser } from '../services/event-push';

describe('pushInstanceEventToUser', () => {
  it('pushes an instance-context event only to the targeted user', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    await pushInstanceEventToUser(env, 'sandbox-1', 'reader-1', 'conversation.read', {
      conversationId: 'conversation-1',
      memberId: 'reader-1',
      lastReadAt: 123,
    });

    expect(pushEvent).toHaveBeenCalledOnce();
    expect(pushEvent).toHaveBeenCalledWith('reader-1', '/kiloclaw/sandbox-1', 'conversation.read', {
      conversationId: 'conversation-1',
      memberId: 'reader-1',
      lastReadAt: 123,
    });
  });
});
