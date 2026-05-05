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
});

describe('pushEventToHumanMembers', () => {
  it('pushes typed payloads to conversation members', async () => {
    const pushEvent = vi.fn().mockResolvedValue(true);
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
        lastReadAt: 123,
      }
    );

    expect(result).toEqual(
      new Map([
        ['member-1', true],
        ['member-2', true],
      ])
    );
    expect(pushEvent).toHaveBeenCalledTimes(2);
    expect(pushEvent).toHaveBeenNthCalledWith(
      1,
      'member-1',
      `/kiloclaw/sandbox-1/${conversationId}`,
      'conversation.read',
      {
        conversationId,
        memberId: 'member-1',
        lastReadAt: 123,
      }
    );
    expect(pushEvent).toHaveBeenNthCalledWith(
      2,
      'member-2',
      `/kiloclaw/sandbox-1/${conversationId}`,
      'conversation.read',
      {
        conversationId,
        memberId: 'member-1',
        lastReadAt: 123,
      }
    );
  });
});

describe('pushInstanceEvent', () => {
  it('pushes typed payloads to instance members', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    const result = await pushInstanceEvent(
      env,
      'sandbox-1',
      ['member-1', 'member-2'],
      'conversation.read',
      {
        conversationId,
        memberId: 'member-1',
        lastReadAt: 123,
      }
    );

    expect(result).toEqual(
      new Map([
        ['member-1', false],
        ['member-2', false],
      ])
    );

    expect(pushEvent).toHaveBeenCalledTimes(2);
    expect(pushEvent).toHaveBeenNthCalledWith(
      1,
      'member-1',
      '/kiloclaw/sandbox-1',
      'conversation.read',
      {
        conversationId,
        memberId: 'member-1',
        lastReadAt: 123,
      }
    );
    expect(pushEvent).toHaveBeenNthCalledWith(
      2,
      'member-2',
      '/kiloclaw/sandbox-1',
      'conversation.read',
      {
        conversationId,
        memberId: 'member-1',
        lastReadAt: 123,
      }
    );
  });

  it('reports delivered instance members', async () => {
    const pushEvent = vi.fn().mockResolvedValue(true);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    const result = await pushInstanceEvent(env, 'sandbox-1', ['member-1'], 'conversation.read', {
      conversationId,
      memberId: 'member-1',
      lastReadAt: 123,
    });

    expect(result).toEqual(new Map([['member-1', true]]));
  });
});
