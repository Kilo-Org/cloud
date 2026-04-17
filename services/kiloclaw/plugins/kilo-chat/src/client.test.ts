import { describe, expect, it, vi } from 'vitest';
import { createKiloChatClient } from './client';

describe('createKiloChatClient', () => {
  it('posts to controller /_kilo/kilo-chat/send with gateway token and conversation id', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ messageId: 'm1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.createMessage({
      conversationId: 'c1',
      content: [{ type: 'text', text: 'hello' }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/send');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('POST');
    const headers = new Headers(init2.headers);
    expect(headers.get('authorization')).toBe('Bearer gwt');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(init2.body as string);
    expect(body).toEqual({ conversationId: 'c1', content: [{ type: 'text', text: 'hello' }] });
    expect(result.messageId).toBe('m1');
  });

  it('throws when the controller returns 2xx without a messageId', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(
      client.createMessage({ conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] })
    ).rejects.toThrow(/missing messageId/);
  });

  it('throws when the controller returns non-2xx', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(
      client.createMessage({ conversationId: 'c1', content: [{ type: 'text', text: 'hi' }] })
    ).rejects.toThrow(/500/);
  });

  it('createMessage posts to /_kilo/kilo-chat/send and returns messageId', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ messageId: 'm1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.createMessage({
      conversationId: 'c1',
      content: [{ type: 'text', text: 'hello' }],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/send');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('POST');
    const body = JSON.parse(init2.body as string);
    expect(body).toEqual({ conversationId: 'c1', content: [{ type: 'text', text: 'hello' }] });
    expect(result).toEqual({ messageId: 'm1' });
  });
});

describe('editMessage', () => {
  it('PATCHes /_kilo/kilo-chat/messages/:id with conversationId, text, timestamp', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ messageId: 'm1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.editMessage({
      conversationId: 'c1',
      messageId: 'm1',
      content: [{ type: 'text', text: 'Hel' }],
      timestamp: 1000,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/messages/m1');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('PATCH');
    const headers = new Headers(init2.headers);
    expect(headers.get('authorization')).toBe('Bearer gwt');
    expect(JSON.parse(init2.body as string)).toEqual({
      conversationId: 'c1',
      content: [{ type: 'text', text: 'Hel' }],
      timestamp: 1000,
    });
    expect(result).toEqual({ messageId: 'm1', stale: false });
  });

  it('returns stale when server response indicates stale', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messageId: 'm1', stale: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    const result = await client.editMessage({
      conversationId: 'c1',
      messageId: 'm1',
      content: [{ type: 'text', text: 'x' }],
      timestamp: 500,
    });
    expect(result).toEqual({ messageId: 'm1', stale: true });
  });

  it('throws on non-2xx responses', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(
      client.editMessage({
        conversationId: 'c1',
        messageId: 'm1',
        content: [{ type: 'text', text: 'x' }],
        timestamp: 1000,
      })
    ).rejects.toThrow(/500/);
  });
});

describe('deleteMessage', () => {
  it('DELETEs /_kilo/kilo-chat/messages/:id with conversationId in body', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.deleteMessage({ conversationId: 'c1', messageId: 'm1' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/messages/m1');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('DELETE');
    expect(JSON.parse(init2.body as string)).toEqual({ conversationId: 'c1' });
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = (async () => new Response('x', { status: 500 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(client.deleteMessage({ conversationId: 'c1', messageId: 'm1' })).rejects.toThrow(
      /500/
    );
  });
});

describe('sendTyping', () => {
  it('POSTs to /_kilo/kilo-chat/typing with conversationId in body and gateway token', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.sendTyping({ conversationId: 'c1' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/typing');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('POST');
    const headers = new Headers(init2.headers);
    expect(headers.get('authorization')).toBe('Bearer gwt');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init2.body as string)).toEqual({ conversationId: 'c1' });
  });

  it('throws on non-2xx so the SDK typing guard can count failures', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(client.sendTyping({ conversationId: 'c1' })).rejects.toThrow(/500/);
  });
});

describe('createKiloChatClient.addReaction', () => {
  it('POSTs to /_kilo/kilo-chat/messages/:id/reactions with body and returns { id }', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: '01JXXXXXXXXXXXXXXXXXXXXXXX' }), { status: 201 });
    }) as typeof fetch;

    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });

    const result = await client.addReaction({
      conversationId: 'C',
      messageId: 'M',
      emoji: '👍',
    });
    expect(result).toEqual({ id: '01JXXXXXXXXXXXXXXXXXXXXXXX' });
    expect(calls[0].url).toBe('http://ctrl/_kilo/kilo-chat/messages/M/reactions');
    expect(calls[0].init.method).toBe('POST');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gw');
    expect(headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ conversationId: 'C', emoji: '👍' });
  });

  it('accepts 200 status (dedupe) and returns the same shape', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: '01JDEDUPE' }), { status: 200 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });
    const r = await client.addReaction({ conversationId: 'C', messageId: 'M', emoji: '👍' });
    expect(r).toEqual({ id: '01JDEDUPE' });
  });

  it('throws on non-2xx response with status + body included in message', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });
    await expect(
      client.addReaction({ conversationId: 'C', messageId: 'M', emoji: '👍' })
    ).rejects.toThrow(/500/);
  });

  it('throws when response is missing id', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 201 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });
    await expect(
      client.addReaction({ conversationId: 'C', messageId: 'M', emoji: '👍' })
    ).rejects.toThrow(/reaction id/i);
  });
});

describe('createKiloChatClient.removeReaction', () => {
  it('DELETEs with body; resolves void on 204', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });
    await client.removeReaction({ conversationId: 'C', messageId: 'M', emoji: '👍' });
    expect(calls[0].url).toBe('http://ctrl/_kilo/kilo-chat/messages/M/reactions');
    expect(calls[0].init.method).toBe('DELETE');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({ conversationId: 'C', emoji: '👍' });
  });

  it('throws on non-2xx response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });
    await expect(
      client.removeReaction({ conversationId: 'C', messageId: 'M', emoji: '👍' })
    ).rejects.toThrow(/403/);
  });

  it('URL-encodes the message id', async () => {
    const calls: Array<string> = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://ctrl',
      gatewayToken: 'gw',
      fetchImpl,
    });
    await client.removeReaction({ conversationId: 'C', messageId: 'M/weird?x=1', emoji: '👍' });
    expect(calls[0]).toBe('http://ctrl/_kilo/kilo-chat/messages/M%2Fweird%3Fx%3D1/reactions');
  });
});
