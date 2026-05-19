import { describe, expect, it, vi } from 'vitest';

import {
  pushBotStatus,
  pushEventToHumanMembers,
  pushInstanceEvent,
  pushInstanceEventToUser,
} from '../services/event-push';

vi.mock('../services/sandbox-ownership', () => ({
  lookupSandboxOwnerUserId: async () => 'owner-1',
}));

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

describe('pushBotStatus', () => {
  it('includes capabilities in the pushed bot.status event when set', async () => {
    const pushEvent = vi.fn().mockResolvedValue(true);
    const putBotStatus = vi.fn();
    const stub = { putBotStatus } as unknown as DurableObjectStub;
    const env = {
      EVENT_SERVICE: { pushEvent },
      SANDBOX_STATUS_DO: {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => stub,
      },
    } as unknown as Env;

    await pushBotStatus(env, 'sandbox-1', {
      online: true,
      at: 1_700_000_000_000,
      capabilities: ['attachments'],
    });

    expect(pushEvent).toHaveBeenCalledOnce();
    const [userId, context, eventName, payload] = pushEvent.mock.calls[0]!;
    expect(userId).toBe('owner-1');
    expect(context).toBe('/kiloclaw/sandbox-1');
    expect(eventName).toBe('bot.status');
    expect(payload).toMatchObject({
      sandboxId: 'sandbox-1',
      online: true,
      at: 1_700_000_000_000,
      capabilities: ['attachments'],
    });
  });
});
