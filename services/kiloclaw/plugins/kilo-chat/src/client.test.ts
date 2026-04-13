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

    const result = await client.sendText({ conversationId: 'c1', text: 'hello' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/send');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('POST');
    const headers = new Headers(init2.headers);
    expect(headers.get('authorization')).toBe('Bearer gwt');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(init2.body as string);
    expect(body).toEqual({ conversationId: 'c1', text: 'hello' });
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
    await expect(client.sendText({ conversationId: 'c1', text: 'hi' })).rejects.toThrow(
      /missing messageId/
    );
  });

  it('throws when the controller returns non-2xx', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    const client = createKiloChatClient({
      controllerBaseUrl: 'http://127.0.0.1:18789',
      gatewayToken: 'gwt',
      fetchImpl,
    });
    await expect(client.sendText({ conversationId: 'c1', text: 'hi' })).rejects.toThrow(/500/);
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

    const result = await client.createMessage({ conversationId: 'c1', text: 'hello' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:18789/_kilo/kilo-chat/send');
    const init2 = init as RequestInit;
    expect(init2.method).toBe('POST');
    const body = JSON.parse(init2.body as string);
    expect(body).toEqual({ conversationId: 'c1', text: 'hello' });
    expect(result).toEqual({ messageId: 'm1', version: 1 });
  });

  it('createMessage defaults version to 1 when server omits it (back-compat)', async () => {
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
    const result = await client.createMessage({ conversationId: 'c1', text: 'hi' });
    expect(result).toEqual({ messageId: 'm1', version: 1 });
  });
});
