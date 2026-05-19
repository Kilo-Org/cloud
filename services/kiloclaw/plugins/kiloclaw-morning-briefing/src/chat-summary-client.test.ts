import { describe, expect, it, vi } from 'vitest';
import { createKiloChatSummaryClient } from './chat-summary-client';
import { buildYesterdayChatWindow } from './chat-summary-utils';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(impl: typeof fetch): typeof fetch {
  return vi.fn(impl) as unknown as typeof fetch;
}

function fetchInputUrl(input: string | Request | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe('chat summary client', () => {
  it('reports unconfigured when the gateway token is missing', async () => {
    const client = createKiloChatSummaryClient({ token: '' });

    expect(client.configured).toBe(false);
    expect(client.reason).toBe('OPENCLAW_GATEWAY_TOKEN is not configured');
    await expect(
      client.listYesterdayConversations(
        buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
      )
    ).resolves.toEqual([]);
  });

  it('lists active conversations and messages through the controller proxy', async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = mockFetch(async (input, init) => {
      const url = fetchInputUrl(input);
      requests.push({ url, init });
      if (url === 'http://controller/_kilo/kilo-chat/conversations?limit=100') {
        return jsonResponse({
          conversations: [
            {
              conversationId: 'conv-1',
              title: 'Launch plan',
              lastActivityAt: Date.parse('2026-05-18T09:00:00.000Z'),
            },
            {
              conversationId: 'conv-old',
              title: 'Old',
              lastActivityAt: Date.parse('2026-05-17T09:00:00.000Z'),
            },
          ],
          hasMore: true,
          nextCursor: 'older-page',
        });
      }
      if (url === 'http://controller/_kilo/kilo-chat/conversations/conv-1/messages?limit=100') {
        return jsonResponse({
          messages: [
            { id: '01JVNY65G00000000000000000', senderId: 'user:1', deleted: false },
            { id: '01JVNY7ZZ00000000000000000', senderId: 'bot:kiloclaw:sbx', deleted: false },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const client = createKiloChatSummaryClient({
      baseUrl: 'http://controller/',
      token: 'token',
      fetchImpl,
    });
    const conversations = await client.listYesterdayConversations(
      buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
    );

    expect(conversations).toEqual([
      {
        conversationId: 'conv-1',
        title: 'Launch plan',
        lastActivityAt: Date.parse('2026-05-18T09:00:00.000Z'),
        messages: [
          { id: '01JVNY65G00000000000000000', senderId: 'user:1', deleted: false },
          { id: '01JVNY7ZZ00000000000000000', senderId: 'bot:kiloclaw:sbx', deleted: false },
        ],
      },
    ]);
    expect(requests.map(request => request.url)).toEqual([
      'http://controller/_kilo/kilo-chat/conversations?limit=100',
      'http://controller/_kilo/kilo-chat/conversations/conv-1/messages?limit=100',
    ]);
    expect(requests[0]?.init).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bearer token' },
    });
  });

  it('throws on non-ok controller responses', async () => {
    const fetchImpl = mockFetch(async () => new Response('no route', { status: 404 }));
    const client = createKiloChatSummaryClient({
      baseUrl: 'http://controller',
      token: 'token',
      fetchImpl,
    });

    await expect(
      client.listYesterdayConversations(
        buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
      )
    ).rejects.toThrow('Kilo Chat controller responded 404: no route');
  });
});
