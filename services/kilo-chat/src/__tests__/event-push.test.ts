import { describe, expect, it, vi } from 'vitest';

import {
  pushEventToHumanMembers,
  pushInstanceEvent,
  pushInstanceEventToUser,
} from '../services/event-push';

const conversationId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

describe('pushInstanceEventToUser', () => {
  it('pushes an instance-context event only to the targeted user', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    await pushInstanceEventToUser(env, 'sandbox-1', 'reader-1', 'conversation.read', {
      conversationId,
      memberId: 'reader-1',
      lastReadAt: 123,
    });

    expect(pushEvent).toHaveBeenCalledOnce();
    expect(pushEvent).toHaveBeenCalledWith('reader-1', '/kiloclaw/sandbox-1', 'conversation.read', {
      conversationId,
      memberId: 'reader-1',
      lastReadAt: 123,
    });
  });

  it('does not push invalid payloads to a targeted user', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    await pushInstanceEventToUser(env, 'sandbox-1', 'reader-1', 'conversation.read', {
      conversationId,
      memberId: 'reader-1',
      lastReadAt: -1,
    } as never);

    expect(pushEvent).not.toHaveBeenCalled();
  });
});

describe('pushEventToHumanMembers', () => {
  it('does not push invalid payloads to conversation members', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    const result = await pushEventToHumanMembers(
      env,
      conversationId,
      'sandbox-1',
      ['member-1', 'member-2'],
      'conversation.read',
      {
        conversationId,
        memberId: 'member-1',
        lastReadAt: -1,
      } as never
    );

    expect(result.size).toBe(0);
    expect(pushEvent).not.toHaveBeenCalled();
  });
});

describe('pushInstanceEvent', () => {
  it('does not push invalid payloads to instance members', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    await pushInstanceEvent(env, 'sandbox-1', ['member-1', 'member-2'], 'conversation.read', {
      conversationId,
      memberId: 'member-1',
      lastReadAt: -1,
    } as never);

    expect(pushEvent).not.toHaveBeenCalled();
  });
});
