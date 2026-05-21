import { describe, it, expect, vi } from 'vitest';
import { KiloChatClient } from '../src/client';
import { KiloChatApiError } from '../src/errors';
import type { KiloChatClientConfig } from '../src/types';

function createMockConfig(fetchFn: typeof globalThis.fetch): KiloChatClientConfig {
  return {
    eventService: { on: vi.fn(() => () => {}) } as unknown as KiloChatClientConfig['eventService'],
    baseUrl: 'https://chat.example.com',
    getToken: vi.fn().mockResolvedValue('test-token'),
    fetch: fetchFn,
  };
}

function mockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('KiloChatClient', () => {
  const sentMessage = {
    id: 'm1',
    senderId: 'user-1',
    content: [{ type: 'text' as const, text: 'hi' }],
    inReplyToMessageId: null,
    replyTo: null,
    updatedAt: null,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
  };

  describe('listConversations', () => {
    it('sends GET /v1/conversations with auth header', async () => {
      const fetch = mockFetch(200, {
        conversations: [],
        hasMore: false,
        nextCursor: null,
      });
      const client = new KiloChatClient(createMockConfig(fetch));
      const res = await client.listConversations();
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/v1/conversations',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        })
      );
      expect(res).toEqual({ conversations: [], hasMore: false, nextCursor: null });
    });

    it('clears stale auth and retries one HTTP request after a 401', async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'stale token' }), { status: 401 })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              conversations: [],
              hasMore: false,
              nextCursor: null,
            }),
            { status: 200 }
          )
        );
      const getToken = vi.fn<() => Promise<string>>();
      getToken.mockResolvedValueOnce('stale-token');
      getToken.mockResolvedValueOnce('fresh-token');
      const onUnauthorized = vi.fn<() => 'retry'>(() => 'retry');
      const client = new KiloChatClient({
        ...createMockConfig(fetch),
        getToken,
        onUnauthorized,
      });

      await expect(client.listConversations()).resolves.toEqual({
        conversations: [],
        hasMore: false,
        nextCursor: null,
      });

      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenNthCalledWith(
        1,
        'https://chat.example.com/v1/conversations',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer stale-token' }),
        })
      );
      expect(fetch).toHaveBeenNthCalledWith(
        2,
        'https://chat.example.com/v1/conversations',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer fresh-token' }),
        })
      );
    });

    it('does not loop when the unauthorized retry also fails', async () => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'stale token' }), { status: 401 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'still stale' }), { status: 401 })
        );
      const onUnauthorized = vi.fn<() => 'retry'>(() => 'retry');
      const client = new KiloChatClient({
        ...createMockConfig(fetch),
        onUnauthorized,
      });

      await expect(client.listConversations()).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('getConversation', () => {
    it('sends GET /v1/conversations/:id', async () => {
      const body = { id: 'abc', title: null, createdBy: 'u1', createdAt: 1, members: [] };
      const fetch = mockFetch(200, body);
      const client = new KiloChatClient(createMockConfig(fetch));
      const res = await client.getConversation('abc');
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/v1/conversations/abc',
        expect.objectContaining({ method: 'GET' })
      );
      expect(res).toEqual(body);
    });
  });

  describe('createConversation', () => {
    it('sends POST /v1/conversations with body and returns the list row', async () => {
      const newUlid = '01HXYZ00000ABCDEFGHJKMNPQR';
      const conversation = {
        conversationId: newUlid,
        title: null,
        lastActivityAt: null,
        lastReadAt: null,
        joinedAt: 123,
      };
      const fetch = mockFetch(201, { conversationId: newUlid, conversation });
      const client = new KiloChatClient(createMockConfig(fetch));
      const res = await client.createConversation({ sandboxId: 'sb-1' });
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/v1/conversations',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ sandboxId: 'sb-1' }),
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );
      expect(res).toEqual({ conversationId: newUlid, conversation });
    });
  });

  describe('listMessages', () => {
    it('returns messages with content as ContentBlock[]', async () => {
      const rawMessages = [
        {
          id: '01HXYZ00000ABCDEFGHIJK01',
          senderId: 'u1',
          content: [{ type: 'text', text: 'hello' }],
          inReplyToMessageId: null,
          replyTo: null,
          updatedAt: null,
          clientUpdatedAt: null,
          deleted: false,
          deliveryFailed: false,
          reactions: [],
        },
      ];
      const fetch = mockFetch(200, { messages: rawMessages });
      const client = new KiloChatClient(createMockConfig(fetch));
      const res = await client.listMessages('conv-1');
      expect(res[0].content).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('sends pagination params as query string', async () => {
      const fetch = mockFetch(200, { messages: [], hasMore: false, nextCursor: null });
      const client = new KiloChatClient(createMockConfig(fetch));
      await client.listMessages('conv-1', { before: 'cursor-id', limit: 25 });
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/v1/conversations/conv-1/messages?before=cursor-id&limit=25',
        expect.anything()
      );
    });

    it('returns an explicit page from listMessagesPage', async () => {
      const page = {
        messages: [],
        hasMore: true,
        nextCursor: '01HXYZ00000ABCDEFGHJKMNPQS',
      };
      const fetch = mockFetch(200, page);
      const client = new KiloChatClient(createMockConfig(fetch));

      await expect(client.listMessagesPage('conv-1', { limit: 25 })).resolves.toEqual(page);
    });
  });

  describe('sendMessage', () => {
    it('sends POST /v1/messages', async () => {
      const fetch = mockFetch(201, { messageId: 'm1', message: sentMessage });
      const client = new KiloChatClient(createMockConfig(fetch));
      const res = await client.sendMessage({
        conversationId: 'c1',
        content: [{ type: 'text', text: 'hi' }],
      });
      expect(res).toEqual({ messageId: 'm1', message: sentMessage });
    });

    it('does not emit unhandled rejections after handled send failures', async () => {
      const unhandledRejection = vi.fn<(reason: unknown) => void>();
      const nodeProcess = globalThis as unknown as {
        process: {
          on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
          off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
        };
      };
      nodeProcess.process.on('unhandledRejection', unhandledRejection);

      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ messageId: 'm2', message: { ...sentMessage, id: 'm2' } }), {
            status: 201,
          })
        );
      const client = new KiloChatClient(createMockConfig(fetch));

      try {
        await expect(
          client.sendMessage({
            conversationId: 'c1',
            content: [{ type: 'text', text: 'fail' }],
          })
        ).rejects.toThrow(KiloChatApiError);

        await new Promise(resolve => setTimeout(resolve, 0));
        await Promise.resolve();
        expect(unhandledRejection).not.toHaveBeenCalled();

        const res = await client.sendMessage({
          conversationId: 'c1',
          content: [{ type: 'text', text: 'retry' }],
        });

        expect(res).toEqual({ messageId: 'm2', message: { ...sentMessage, id: 'm2' } });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenNthCalledWith(
          2,
          'https://chat.example.com/v1/messages',
          expect.objectContaining({ method: 'POST' })
        );
      } finally {
        nodeProcess.process.off('unhandledRejection', unhandledRejection);
      }
    });
  });

  describe('executeAction', () => {
    it('returns the canonical resolved message content', async () => {
      const response = {
        ok: true,
        messageId: '01HXYZ00000ABCDEFGHJKMNPQS',
        content: [
          {
            type: 'actions',
            groupId: 'approval',
            actions: [{ value: 'deny', label: 'Deny', style: 'danger' }],
            resolved: {
              value: 'deny',
              resolvedBy: 'user-1',
              resolvedAt: 123,
            },
          },
        ],
        resolved: {
          groupId: 'approval',
          value: 'deny',
          resolvedBy: 'user-1',
          resolvedAt: 123,
        },
      };
      const fetch = mockFetch(200, response);
      const client = new KiloChatClient(createMockConfig(fetch));

      await expect(
        client.executeAction('conv-1', response.messageId, {
          groupId: 'approval',
          value: 'deny',
        })
      ).resolves.toEqual(response);
    });
  });

  describe('editMessage', () => {
    it('sends PATCH /v1/messages/:id', async () => {
      const fetch = mockFetch(200, { messageId: 'm1' });
      const client = new KiloChatClient(createMockConfig(fetch));
      const res = await client.editMessage('m1', {
        conversationId: 'c1',
        content: [{ type: 'text', text: 'edited' }],
        timestamp: Date.now(),
      });
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/v1/messages/m1',
        expect.objectContaining({ method: 'PATCH' })
      );
      expect(res).toEqual({ messageId: 'm1' });
    });
  });

  describe('deleteMessage', () => {
    it('sends DELETE /v1/messages/:id with conversationId query param', async () => {
      const fetch = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 204, json: () => Promise.resolve(null) });
      const client = new KiloChatClient(createMockConfig(fetch));
      const res = await client.deleteMessage('m1', { conversationId: 'c1' });
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/v1/messages/m1?conversationId=c1',
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(res).toBeUndefined();
    });
  });

  describe('sendTyping', () => {
    it('sends POST /v1/conversations/:id/typing', async () => {
      const fetch = mockFetch(200, {});
      const client = new KiloChatClient(createMockConfig(fetch));
      await client.sendTyping('conv-1');
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/v1/conversations/conv-1/typing',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('error handling', () => {
    it('throws KiloChatApiError on non-ok response', async () => {
      const fetch = mockFetch(403, { error: 'Forbidden' });
      const client = new KiloChatClient(createMockConfig(fetch));
      await expect(client.listConversations()).rejects.toThrow(KiloChatApiError);
      await expect(client.listConversations()).rejects.toMatchObject({
        status: 403,
        body: { error: 'Forbidden' },
      });
    });

    it('calls getToken before each request', async () => {
      const fetch = mockFetch(200, { conversations: [], hasMore: false, nextCursor: null });
      const config = createMockConfig(fetch);
      const client = new KiloChatClient(config);
      await client.listConversations();
      await client.listConversations();
      expect(config.getToken).toHaveBeenCalledTimes(2);
    });

    it('rejects malformed response bodies', async () => {
      const fetch = mockFetch(200, { conversations: 'not-an-array' });
      const client = new KiloChatClient(createMockConfig(fetch));
      await expect(client.listConversations()).rejects.toThrow();
    });
  });
});
