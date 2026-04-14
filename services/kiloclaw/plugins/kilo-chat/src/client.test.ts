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

  it('createMessage posts to /_kilo/kilo-chat/send and returns messageId + version', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ messageId: 'm1', version: 1 }), {
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
    expect(result).toEqual({ messageId: 'm1', version: 1 });
  });

  it('createMessage defaults version to 1 when server omits it', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ messageId: 'm1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    const result = await client.createMessage({
      conversationId: 'c1',
      content: [{ type: 'text', text: 'hi' }],
    });
    expect(result).toEqual({ messageId: 'm1', version: 1 });
  });
});

describe('editMessage', () => {
  it('PATCHes /_kilo/kilo-chat/messages/:id with conversationId, text, version', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ messageId: 'm1', version: 3 }), {
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
      version: 3,
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
      version: 3,
    });
    expect(result).toEqual({ messageId: 'm1', version: 3 });
  });

  it('returns a dropped-edit sentinel on 409 without throwing', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'stale version' }), {
        status: 409,
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
      version: 1,
    });
    // version echoed back equals the requested version; caller treats as drop.
    expect(result).toEqual({ messageId: 'm1', version: 1, dropped: true });
  });

  it('throws on other non-2xx responses', async () => {
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
        version: 1,
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
