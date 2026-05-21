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

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidFromTimestamp(timestamp: number, suffix = '0000000000000000'): string {
  let value = timestamp;
  let encoded = '';
  for (let i = 0; i < 10; i += 1) {
    encoded = CROCKFORD_BASE32[value % 32] + encoded;
    value = Math.floor(value / 32);
  }
  return `${encoded}${suffix}`;
}

function createConfiguredClient(
  options: Parameters<typeof createKiloChatSummaryClient>[0]
): ReturnType<typeof createKiloChatSummaryClient> {
  return createKiloChatSummaryClient({
    sandboxId: 'sandbox-1',
    kiloChatBaseUrl: 'https://chat.example.com',
    ...options,
  });
}

describe('chat summary client', () => {
  it('reports unconfigured when the gateway token is missing', async () => {
    const client = createKiloChatSummaryClient({ token: '' });

    expect(client.configured).toBe(false);
    expect(client.reason).toBe('OPENCLAW_GATEWAY_TOKEN is not configured');
    await expect(
      client.listConversationsForWindow(
        buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
      )
    ).resolves.toEqual({ conversations: [], truncated: false });
  });

  it('reports unconfigured when controller chat route prerequisites are missing', () => {
    expect(
      createKiloChatSummaryClient({
        token: 'token',
        sandboxId: '',
        kiloChatBaseUrl: 'https://chat.example.com',
      })
    ).toMatchObject({
      configured: false,
      reason: 'KILOCLAW_SANDBOX_ID is not configured',
    });
    expect(
      createKiloChatSummaryClient({ token: 'token', sandboxId: 'sandbox-1', kiloChatBaseUrl: '' })
    ).toMatchObject({
      configured: false,
      reason: 'KILOCHAT_BASE_URL is not configured',
    });
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

    const client = createConfiguredClient({
      baseUrl: 'http://controller/',
      token: 'token',
      fetchImpl,
    });
    const result = await client.listConversationsForWindow(
      buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
    );

    expect(result.truncated).toBe(false);
    expect(result.conversations).toEqual([
      {
        conversationId: 'conv-1',
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
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('inspects conversations whose latest activity is after the window', async () => {
    // A thread that started yesterday and continued today reports a
    // lastActivityAt of today, but still holds yesterday-window messages.
    // It must be scanned or yesterday stats undercount spanning threads.
    const yesterdayMessage = ulidFromTimestamp(
      Date.parse('2026-05-18T22:00:00.000Z'),
      '0000000000000001'
    );
    const todayMessage = ulidFromTimestamp(
      Date.parse('2026-05-19T08:00:00.000Z'),
      '0000000000000002'
    );
    const requests: string[] = [];
    const fetchImpl = mockFetch(async input => {
      const url = fetchInputUrl(input);
      requests.push(url);
      if (url === 'http://controller/_kilo/kilo-chat/conversations?limit=100') {
        return jsonResponse({
          conversations: [
            {
              conversationId: 'conv-spanning',
              lastActivityAt: Date.parse('2026-05-19T08:00:00.000Z'),
            },
            {
              conversationId: 'conv-before-window',
              lastActivityAt: Date.parse('2026-05-17T09:00:00.000Z'),
            },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      if (
        url === 'http://controller/_kilo/kilo-chat/conversations/conv-spanning/messages?limit=100'
      ) {
        return jsonResponse({
          messages: [
            { id: todayMessage, senderId: 'user:1', deleted: false },
            { id: yesterdayMessage, senderId: 'user:1', deleted: false },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const client = createConfiguredClient({
      baseUrl: 'http://controller',
      token: 'token',
      fetchImpl,
    });
    const result = await client.listConversationsForWindow(
      buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
    );

    // conv-spanning is scanned even though its latest activity is today;
    // conv-before-window is skipped because it cannot hold yesterday messages.
    expect(result.conversations.map(conversation => conversation.conversationId)).toEqual([
      'conv-spanning',
    ]);
    expect(result.conversations[0]?.messages.map(message => message.id)).toEqual([
      todayMessage,
      yesterdayMessage,
    ]);
    expect(requests).toEqual([
      'http://controller/_kilo/kilo-chat/conversations?limit=100',
      'http://controller/_kilo/kilo-chat/conversations/conv-spanning/messages?limit=100',
    ]);
  });

  it('keeps paginating when a page is not sorted by descending activity', async () => {
    const requests: string[] = [];
    const fetchImpl = mockFetch(async input => {
      const url = fetchInputUrl(input);
      requests.push(url);
      if (url === 'http://controller/_kilo/kilo-chat/conversations?limit=100') {
        return jsonResponse({
          conversations: [
            {
              conversationId: 'conv-old-first',
              title: 'Old first',
              lastActivityAt: Date.parse('2026-05-17T17:00:00.000Z'),
            },
            {
              conversationId: 'conv-yesterday-later',
              title: 'Yesterday later',
              lastActivityAt: Date.parse('2026-05-18T17:00:00.000Z'),
            },
          ],
          hasMore: true,
          nextCursor: 'next-page',
        });
      }
      if (url === 'http://controller/_kilo/kilo-chat/conversations?limit=100&cursor=next-page') {
        return jsonResponse({
          conversations: [
            {
              conversationId: 'conv-yesterday-next-page',
              title: 'Yesterday next page',
              lastActivityAt: Date.parse('2026-05-18T12:00:00.000Z'),
            },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      if (
        url ===
          'http://controller/_kilo/kilo-chat/conversations/conv-yesterday-later/messages?limit=100' ||
        url ===
          'http://controller/_kilo/kilo-chat/conversations/conv-yesterday-next-page/messages?limit=100'
      ) {
        return jsonResponse({
          messages: [{ id: '01JVPPRVG00000000000000000', senderId: 'user:1', deleted: false }],
          hasMore: false,
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const client = createConfiguredClient({
      baseUrl: 'http://controller',
      token: 'token',
      fetchImpl,
    });
    const result = await client.listConversationsForWindow(
      buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
    );

    expect(result.conversations.map(conversation => conversation.conversationId)).toEqual([
      'conv-yesterday-later',
      'conv-yesterday-next-page',
    ]);
    expect(requests).toContain(
      'http://controller/_kilo/kilo-chat/conversations?limit=100&cursor=next-page'
    );
  });

  it('keeps paginating messages when a page is not sorted newest-first', async () => {
    const inWindowEarly = ulidFromTimestamp(
      Date.parse('2026-05-18T10:00:00.000Z'),
      '0000000000000001'
    );
    const inWindowLate = ulidFromTimestamp(
      Date.parse('2026-05-18T08:00:00.000Z'),
      '0000000000000002'
    );
    const beforeWindowOne = ulidFromTimestamp(
      Date.parse('2026-05-17T05:00:00.000Z'),
      '0000000000000003'
    );
    const beforeWindowTwo = ulidFromTimestamp(
      Date.parse('2026-05-17T03:00:00.000Z'),
      '0000000000000004'
    );
    const secondPageMessage = ulidFromTimestamp(
      Date.parse('2026-05-18T06:00:00.000Z'),
      '0000000000000005'
    );

    const requests: string[] = [];
    const fetchImpl = mockFetch(async input => {
      const url = fetchInputUrl(input);
      requests.push(url);
      if (url === 'http://controller/_kilo/kilo-chat/conversations?limit=100') {
        return jsonResponse({
          conversations: [
            {
              conversationId: 'conv-1',
              lastActivityAt: Date.parse('2026-05-18T10:00:00.000Z'),
            },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      if (url === 'http://controller/_kilo/kilo-chat/conversations/conv-1/messages?limit=100') {
        // Out-of-order page: an in-window message sits between two
        // before-window messages, and the page's last message is old.
        // The legacy "last message only" check would stop here.
        return jsonResponse({
          messages: [
            { id: beforeWindowOne, senderId: 'user:1', deleted: false },
            { id: inWindowEarly, senderId: 'user:1', deleted: false },
            { id: beforeWindowTwo, senderId: 'user:1', deleted: false },
          ],
          hasMore: true,
          nextCursor: 'page-2',
        });
      }
      if (
        url ===
        'http://controller/_kilo/kilo-chat/conversations/conv-1/messages?limit=100&before=page-2'
      ) {
        return jsonResponse({
          messages: [
            { id: inWindowLate, senderId: 'user:1', deleted: false },
            { id: secondPageMessage, senderId: 'bot:kiloclaw:sbx', deleted: false },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const client = createConfiguredClient({
      baseUrl: 'http://controller',
      token: 'token',
      fetchImpl,
    });
    const result = await client.listConversationsForWindow(
      buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
    );

    expect(result.truncated).toBe(false);
    expect(result.conversations[0]?.messages.map(message => message.id)).toEqual([
      beforeWindowOne,
      inWindowEarly,
      beforeWindowTwo,
      inWindowLate,
      secondPageMessage,
    ]);
    expect(requests).toContain(
      'http://controller/_kilo/kilo-chat/conversations/conv-1/messages?limit=100&before=page-2'
    );
  });

  it('flags truncation when a conversation exceeds the message page cap', async () => {
    const fetchImpl = mockFetch(async input => {
      const url = fetchInputUrl(input);
      if (url === 'http://controller/_kilo/kilo-chat/conversations?limit=100') {
        return jsonResponse({
          conversations: [
            {
              conversationId: 'conv-1',
              lastActivityAt: Date.parse('2026-05-18T10:00:00.000Z'),
            },
          ],
          hasMore: false,
          nextCursor: null,
        });
      }
      // Every message page stays in-window and always reports another page,
      // so the scan can only end by hitting the page cap.
      return jsonResponse({
        messages: [
          {
            id: ulidFromTimestamp(Date.parse('2026-05-18T09:00:00.000Z')),
            senderId: 'user:1',
            deleted: false,
          },
        ],
        hasMore: true,
        nextCursor: 'keep-going',
      });
    });

    const client = createConfiguredClient({
      baseUrl: 'http://controller',
      token: 'token',
      fetchImpl,
    });
    const result = await client.listConversationsForWindow(
      buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
    );

    expect(result.truncated).toBe(true);
  });

  it('throws on non-ok controller responses', async () => {
    const fetchImpl = mockFetch(async () => new Response('no route', { status: 404 }));
    const client = createConfiguredClient({
      baseUrl: 'http://controller',
      token: 'token',
      fetchImpl,
    });

    await expect(
      client.listConversationsForWindow(
        buildYesterdayChatWindow(new Date('2026-05-19T12:00:00.000Z'), 'UTC')
      )
    ).rejects.toThrow('Kilo Chat controller responded 404: no route');
  });
});
