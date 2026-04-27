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
    it('sends POST /v1/conversations with body', async () => {
      const newUlid = '01HXYZ00000ABCDEFGHJKMNPQR';
      const fetch = mockFetch(201, { conversationId: newUlid });
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
      expect(res).toEqual({ conversationId: newUlid });
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
      const fetch = mockFetch(200, { messages: [] });
      const client = new KiloChatClient(createMockConfig(fetch));
      await client.listMessages('conv-1', { before: 'cursor-id', limit: 25 });
      expect(fetch).toHaveBeenCalledWith(
        'https://chat.example.com/v1/conversations/conv-1/messages?before=cursor-id&limit=25',
        expect.anything()
      );
    });
  });

  describe('sendMessage', () => {
    it('sends POST /v1/messages', async () => {
      const fetch = mockFetch(201, { messageId: 'm1' });
      const client = new KiloChatClient(createMockConfig(fetch));
      const res = await client.sendMessage({
        conversationId: 'c1',
        content: [{ type: 'text', text: 'hi' }],
      });
      expect(res).toEqual({ messageId: 'm1' });
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
