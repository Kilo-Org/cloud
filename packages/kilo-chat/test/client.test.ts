import { describe, it, expect, vi } from 'vitest';
import { KiloChatClient } from '../src/client';
import { KiloChatApiError } from '../src/errors';
import { RequestDeadlineError } from '@kilocode/event-service';
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

type MethodCase =
  | { kind: 'action'; invoke: (client: KiloChatClient) => Promise<unknown> }
  | { kind: 'read' | 'event' | 'control' };

// Exhaustive public-method inventory. New methods must choose an admission class.
const methodInventory: Record<keyof KiloChatClient, MethodCase> = {
  sendMessage: { kind: 'action', invoke: c => c.sendMessage({ conversationId: 'c', content: [] }) },
  editMessage: {
    kind: 'action',
    invoke: c => c.editMessage('m', { conversationId: 'c', content: [], timestamp: 1 }),
  },
  deleteMessage: { kind: 'action', invoke: c => c.deleteMessage('m', { conversationId: 'c' }) },
  createConversation: { kind: 'action', invoke: c => c.createConversation({ sandboxId: 's' }) },
  renameConversation: {
    kind: 'action',
    invoke: c => c.renameConversation('c', { title: 'renamed' }),
  },
  leaveConversation: { kind: 'action', invoke: c => c.leaveConversation('c') },
  sendTyping: { kind: 'action', invoke: c => c.sendTyping('c') },
  markConversationRead: {
    kind: 'action',
    invoke: c => c.markConversationRead('c', { lastSeenMessageId: 'm' }),
  },
  addReaction: {
    kind: 'action',
    invoke: c => c.addReaction('m', { conversationId: 'c', emoji: '+1' }),
  },
  removeReaction: {
    kind: 'action',
    invoke: c => c.removeReaction('m', { conversationId: 'c', emoji: '+1' }),
  },
  redeliverMessage: { kind: 'action', invoke: c => c.redeliverMessage('c', 'm') },
  executeAction: {
    kind: 'action',
    invoke: c => c.executeAction('c', 'm', { groupId: 'g', value: 'allow-once' }),
  },
  initAttachment: {
    kind: 'action',
    invoke: c =>
      c.initAttachment({
        conversationId: 'c',
        filename: 'a.png',
        mimeType: 'image/png',
        size: 1,
        idempotencyKey: 'a',
      }),
  },
  getAttachmentUrl: { kind: 'read' },
  listConversations: { kind: 'read' },
  getConversation: { kind: 'read' },
  getBotStatus: { kind: 'read' },
  requestBotStatus: { kind: 'read' },
  getConversationStatus: { kind: 'read' },
  listMessages: { kind: 'read' },
  listMessagesPage: { kind: 'read' },
  sendTypingStop: { kind: 'control' },
  captureOperation: { kind: 'control' },
  canPublish: { kind: 'control' },
  canStartOperation: { kind: 'control' },
  assertOwner: { kind: 'control' },
  dispose: { kind: 'control' },
  on: { kind: 'event' },
  onMessageCreated: { kind: 'event' },
  onMessageUpdated: { kind: 'event' },
  onMessageDeleted: { kind: 'event' },
  onMessageDeliveryFailed: { kind: 'event' },
  onMessageRedelivered: { kind: 'event' },
  onActionDeliveryFailed: { kind: 'event' },
  onTyping: { kind: 'event' },
  onTypingStop: { kind: 'event' },
  onReactionAdded: { kind: 'event' },
  onReactionRemoved: { kind: 'event' },
  onConversationCreated: { kind: 'event' },
  onConversationRenamed: { kind: 'event' },
  onConversationLeft: { kind: 'event' },
  onConversationRead: { kind: 'event' },
  onConversationActivity: { kind: 'event' },
  onBotStatus: { kind: 'event' },
  onConversationStatus: { kind: 'event' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function ownedClient(overrides: Partial<KiloChatClientConfig> = {}) {
  const state = { generation: 0, unlocked: true, owner: true };
  const requests: string[] = [];
  const client = new KiloChatClient({
    ...createMockConfig(async input => {
      requests.push(input instanceof Request ? input.url : input.toString());
      return Response.json({ conversations: [], hasMore: false, nextCursor: null });
    }),
    canPublish: () => state.owner,
    captureOperationAdmission: () => {
      const generation = state.generation;
      return () => {
        if (!state.unlocked || generation !== state.generation) throw new Error('stale admission');
      };
    },
    ...overrides,
  });
  return { client, state, requests };
}

const admittedMessage = {
  id: 'm1',
  senderId: 'user-a',
  content: [{ type: 'text', text: 'accepted' }],
  inReplyToMessageId: null,
  replyTo: null,
  updatedAt: null,
  clientUpdatedAt: null,
  deleted: false,
  deliveryFailed: false,
  reactions: [],
};

describe('operation admission and ownership', () => {
  for (const [name, entry] of Object.entries(methodInventory)) {
    if (entry.kind !== 'action') continue;
    it(`denies ${name} before credentials or HTTP when locked`, async () => {
      let tokenReads = 0;
      const { client, state, requests } = ownedClient({
        getToken: async () => {
          tokenReads++;
          return 'a';
        },
      });
      state.unlocked = false;
      await expect(entry.invoke(client)).rejects.toThrow('stale admission');
      expect({ tokenReads, requests }).toEqual({ tokenReads: 0, requests: [] });
    });
  }

  it('rejects a delayed token after lock/unlock without sending the draft', async () => {
    const token = deferred<string>();
    const entered = deferred<void>();
    const { client, state, requests } = ownedClient({
      getToken: () => {
        entered.resolve();
        return token.promise;
      },
    });
    const pending = client.sendMessage({
      conversationId: 'c',
      content: [{ type: 'text', text: 'unsent' }],
    });
    await entered.promise;
    state.generation++;
    token.resolve('a');
    await expect(pending).rejects.toThrow('stale admission');
    expect(requests).toEqual([]);
  });

  it('keeps an accepted send but rejects the queued send after lock/unlock', async () => {
    const response = deferred<Response>();
    const requests: string[] = [];
    const { client, state } = ownedClient({
      fetch: async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
        requests.push(init.body);
        return response.promise;
      },
    });
    const accepted = client.sendMessage({
      conversationId: 'c',
      content: [{ type: 'text', text: 'accepted' }],
    });
    const queued = client.sendMessage({
      conversationId: 'c',
      content: [{ type: 'text', text: 'unsent' }],
    });
    const rejected = expect(queued).rejects.toThrow('stale admission');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    state.generation++;
    response.resolve(Response.json({ messageId: 'm1', message: admittedMessage }));
    await expect(accepted).resolves.toMatchObject({ messageId: 'm1' });
    await rejected;
    expect(requests.map(body => JSON.parse(body).content[0].text)).toEqual(['accepted']);
  });

  it('does not renew admission across an unauthorized retry', async () => {
    const recovery = deferred<'retry'>();
    const recovering = deferred<void>();
    const requests: string[] = [];
    const { client, state } = ownedClient({
      fetch: async input => {
        requests.push(input instanceof Request ? input.url : input.toString());
        return Response.json({ error: 'expired' }, { status: 401 });
      },
      onUnauthorized: () => {
        recovering.resolve();
        return recovery.promise;
      },
    });
    const pending = client.executeAction('c', 'm', { groupId: 'g', value: 'allow-once' });
    await recovering.promise;
    state.generation++;
    recovery.resolve('retry');
    await expect(pending).rejects.toThrow('stale admission');
    expect(requests).toEqual([
      'https://chat.example.com/v1/conversations/c/messages/m/execute-action',
    ]);
  });

  it('disposes token waits and queued sends without waiting for their deadlines', async () => {
    const token = deferred<string>();
    const entered = deferred<void>();
    const { client, requests } = ownedClient({
      getToken: () => {
        entered.resolve();
        return token.promise;
      },
    });
    const first = client.sendMessage({ conversationId: 'c', content: [] });
    const queued = client.sendMessage({ conversationId: 'c', content: [] });
    const settled = Promise.allSettled([first, queued]);
    await entered.promise;
    client.dispose();
    expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected']);
    token.resolve('old');
    await Promise.resolve();
    expect(requests).toEqual([]);
  });

  it('rejects an old read response instead of returning it to a replacement owner', async () => {
    const response = deferred<Response>();
    const { client, state } = ownedClient({ fetch: () => response.promise });
    const pending = client.listConversations();
    await Promise.resolve();
    state.owner = false;
    response.resolve(Response.json({ conversations: [], hasMore: false, nextCursor: null }));
    await expect(pending).rejects.toThrow('owner is no longer active');
  });

  it('allows owner-fenced reads and stop-typing cleanup while locked', async () => {
    const requests: string[] = [];
    const { client, state } = ownedClient({
      fetch: async input => {
        requests.push(input instanceof Request ? input.url : input.toString());
        return Response.json({ conversations: [], hasMore: false, nextCursor: null });
      },
    });
    state.unlocked = false;
    await expect(client.listConversations()).resolves.toMatchObject({ conversations: [] });
    await expect(client.sendTypingStop('c')).resolves.toBeUndefined();
    expect(requests).toHaveLength(2);
  });
});

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

  describe('request deadlines', () => {
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

    it('timed-out send releases the conversation queue for the next send', async () => {
      vi.useFakeTimers();
      try {
        // First fetch hangs and respects the abort signal. Second fetch resolves.
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockImplementationOnce((_url, init) => {
            return new Promise<Response>((_resolve, reject) => {
              const signal = init?.signal;
              if (signal) {
                signal.addEventListener('abort', () => {
                  reject(signal.reason);
                });
              }
            });
          })
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ messageId: 'm2', message: { ...sentMessage, id: 'm2' } }),
              {
                status: 201,
              }
            )
          );

        const client = new KiloChatClient(createMockConfig(fetch));

        // Queue send 1 — it will hang on fetch.
        const send1Promise = client.sendMessage({
          conversationId: 'c1',
          content: [{ type: 'text', text: 'first' }],
        });

        // Queue send 2 immediately — chained after send 1's promise.
        const send2Promise = client.sendMessage({
          conversationId: 'c1',
          content: [{ type: 'text', text: 'second' }],
        });

        // Suppress unhandled rejections during fake-timer advance.
        send1Promise.catch(() => {});

        // Advance past the 30s send deadline.
        await vi.advanceTimersByTimeAsync(30_001);

        // Send 1 rejects with RequestDeadlineError.
        await expect(send1Promise).rejects.toThrow(RequestDeadlineError);

        // Send 2 goes through — the queue was not blocked.
        await expect(send2Promise).resolves.toEqual({
          messageId: 'm2',
          message: { ...sentMessage, id: 'm2' },
        });

        expect(fetch).toHaveBeenCalledTimes(2);
        // First fetch: timed-out POST
        expect(fetch).toHaveBeenNthCalledWith(
          1,
          'https://chat.example.com/v1/messages',
          expect.objectContaining({ method: 'POST' })
        );
        // Second fetch: successful POST after queue release
        expect(fetch).toHaveBeenNthCalledWith(
          2,
          'https://chat.example.com/v1/messages',
          expect.objectContaining({ method: 'POST' })
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('control-plane deadline applies to listConversations', async () => {
      vi.useFakeTimers();
      try {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce((_url, init) => {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(signal.reason);
              });
            }
          });
        });

        const client = new KiloChatClient(createMockConfig(fetch));
        const promise = client.listConversations();
        promise.catch(() => {}); // suppress unhandled rejection

        // Advance past 15s control-plane deadline.
        await vi.advanceTimersByTimeAsync(15_001);

        await expect(promise).rejects.toThrow(RequestDeadlineError);
        await expect(promise).rejects.toThrow('timed out after 15000ms');
      } finally {
        vi.useRealTimers();
      }
    });

    it('successful send completes within deadline', async () => {
      vi.useFakeTimers();
      try {
        const fetch = vi
          .fn<typeof globalThis.fetch>()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ messageId: 'm1', message: sentMessage }), { status: 201 })
          );

        const client = new KiloChatClient(createMockConfig(fetch));
        const promise = client.sendMessage({
          conversationId: 'c1',
          content: [{ type: 'text', text: 'hi' }],
        });

        // Advance a small amount — well under the 30s deadline.
        await vi.advanceTimersByTimeAsync(100);
        await expect(promise).resolves.toEqual({ messageId: 'm1', message: sentMessage });
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('timeout does not trigger unauthorized recovery', async () => {
      vi.useFakeTimers();
      try {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce((_url, init) => {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(signal.reason);
              });
            }
          });
        });

        const onUnauthorized = vi.fn<() => 'retry'>(() => 'retry');
        const client = new KiloChatClient({
          ...createMockConfig(fetch),
          onUnauthorized,
        });

        const promise = client.listConversations();
        promise.catch(() => {}); // suppress unhandled rejection

        await vi.advanceTimersByTimeAsync(15_001);

        // Rejects with a deadline error, NOT an auth error.
        await expect(promise).rejects.toThrow(RequestDeadlineError);

        // onUnauthorized must NOT be called — timeouts are not auth failures.
        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1); // no retry
      } finally {
        vi.useRealTimers();
      }
    });

    it('ABORT: no automatic resend after a timed-out send', async () => {
      vi.useFakeTimers();
      try {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce((_url, init) => {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(signal.reason);
              });
            }
          });
        });

        const client = new KiloChatClient(createMockConfig(fetch));
        const promise = client.sendMessage({
          conversationId: 'c1',
          content: [{ type: 'text', text: 'timeout' }],
        });
        promise.catch(() => {}); // suppress unhandled rejection

        // Advance past the 30s send deadline.
        await vi.advanceTimersByTimeAsync(30_001);

        await expect(promise).rejects.toThrow(RequestDeadlineError);

        // No automatic resend: fetch called exactly once (not retried).
        expect(fetch).toHaveBeenCalledTimes(1);

        // Advance further — still no additional fetch calls.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ABORT: send deadline is 30s', async () => {
      vi.useFakeTimers();
      try {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce((_url, init) => {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(signal.reason);
              });
            }
          });
        });

        const client = new KiloChatClient(createMockConfig(fetch));
        const sendPromise = client.sendMessage({
          conversationId: 'c1',
          content: [{ type: 'text', text: 'hi' }],
        });
        sendPromise.catch(() => {}); // suppress unhandled rejection

        // At 15s, the send should still be alive (send deadline is 30s).
        await vi.advanceTimersByTimeAsync(15_000);

        // At 30s, it should reject.
        await vi.advanceTimersByTimeAsync(15_001);
        await expect(sendPromise).rejects.toThrow('timed out after 30000ms');
      } finally {
        vi.useRealTimers();
      }
    });

    it('ABORT: control-plane deadline is 15s', async () => {
      vi.useFakeTimers();
      try {
        const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce((_url, init) => {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(signal.reason);
              });
            }
          });
        });

        const client = new KiloChatClient(createMockConfig(fetch));
        const promise = client.listConversations();
        promise.catch(() => {}); // suppress unhandled rejection

        await vi.advanceTimersByTimeAsync(15_001);
        await expect(promise).rejects.toThrow('timed out after 15000ms');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
