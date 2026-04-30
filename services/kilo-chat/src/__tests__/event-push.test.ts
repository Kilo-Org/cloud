import { describe, expect, it, vi } from 'vitest';

import {
  pushEventToHumanMembers,
  pushInstanceEvent,
  pushInstanceEventToUser,
} from '../services/event-push';
import { logger } from '../util/logger';

describe('pushEventToHumanMembers', () => {
  it('logs and skips invalid producer payloads before event-service delivery', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    try {
      await Reflect.apply(pushEventToHumanMembers, undefined, [
        env,
        'conversation-1',
        'sandbox-1',
        ['reader-1'],
        'conversation.read',
        { conversationId: 'conversation-1', memberId: 'reader-1' },
      ]);

      expect(pushEvent).not.toHaveBeenCalled();
      expect(logError).toHaveBeenCalledWith(
        'Invalid kilo-chat event payload',
        expect.objectContaining({ event: 'conversation.read', conversationId: 'conversation-1' })
      );
    } finally {
      logError.mockRestore();
    }
  });

  it('delivers valid conversation-scoped producer payloads after validation', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;
    const message = {
      id: 'message-1',
      senderId: 'user-1',
      content: [{ type: 'text' as const, text: 'hello' }],
      inReplyToMessageId: null,
      updatedAt: null,
      clientUpdatedAt: null,
      version: 1,
      deleted: false,
      deliveryFailed: false,
      reactions: [],
    };

    await pushEventToHumanMembers(
      env,
      'conversation-1',
      'sandbox-1',
      ['reader-1'],
      'message.updated',
      {
        messageId: 'message-1',
        content: [{ type: 'text', text: 'edited' }],
        clientUpdatedAt: 123,
        version: 2,
      }
    );
    await pushEventToHumanMembers(
      env,
      'conversation-1',
      'sandbox-1',
      ['reader-1'],
      'conversation.status',
      {
        conversationId: 'conversation-1',
        contextTokens: 100,
        contextWindow: 200,
        model: 'model-1',
        provider: 'provider-1',
        at: 456,
      }
    );
    await pushEventToHumanMembers(
      env,
      'conversation-1',
      'sandbox-1',
      ['reader-1'],
      'message.created',
      {
        messageId: 'message-1',
        message,
        senderId: 'user-1',
        content: message.content,
        inReplyToMessageId: null,
        clientId: null,
        version: 1,
      }
    );

    expect(pushEvent).toHaveBeenCalledTimes(3);
  });
});

describe('pushInstanceEvent', () => {
  it('delivers valid instance-scoped producer payloads after validation', async () => {
    const pushEvent = vi.fn().mockResolvedValue(false);
    const env = { EVENT_SERVICE: { pushEvent } } as unknown as Env;

    await pushInstanceEvent(env, 'sandbox-1', ['reader-1'], 'conversation.created', {
      conversationId: 'conversation-1',
      sandboxId: 'sandbox-1',
      conversationListItem: {
        conversationId: 'conversation-1',
        title: null,
        lastActivityAt: null,
        lastReadAt: null,
        joinedAt: 1,
      },
    });
    await pushInstanceEvent(env, 'sandbox-1', ['reader-1'], 'conversation.read', {
      conversationId: 'conversation-1',
      memberId: 'reader-1',
      lastReadAt: 123,
    });
    await pushInstanceEvent(env, 'sandbox-1', ['reader-1'], 'bot.status', {
      sandboxId: 'sandbox-1',
      online: true,
      at: 456,
    });

    expect(pushEvent).toHaveBeenCalledTimes(3);
  });
});

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
