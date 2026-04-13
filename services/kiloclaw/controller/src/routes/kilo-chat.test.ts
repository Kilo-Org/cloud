import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  registerKiloChatSendRoute,
  registerKiloChatEditRoute,
  registerKiloChatDeleteRoute,
} from './kilo-chat';

const TOKEN = 'expected-gateway-token';
const SANDBOX_ID = 'sbx_test';

function makeApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatSendRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    apiToken: 'api_token',
    baseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('POST /_kilo/kilo-chat/send', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeApp(async () => new Response('', { status: 200 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/send', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1', text: 'hi' }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const app = makeApp(async () => new Response('', { status: 200 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/send', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1', text: 'hi' }),
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong',
        },
      })
    );
    expect(res.status).toBe(401);
  });

  it('forwards authorized requests with sandbox id header and api token', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ messageId: 'm1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/send', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1', text: 'hi' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe('https://chat.example.test/v1/messages');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer api_token');
    expect(headers.get('x-kilo-sandbox-id')).toBe(SANDBOX_ID);
    const body = JSON.parse((capturedInit?.body as string) ?? '{}');
    expect(body).toEqual({ conversationId: 'c1', text: 'hi' });
  });

  it('surfaces upstream error status', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 502 })) as typeof fetch;
    const app = makeApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/send', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1', text: 'hi' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(res.status).toBe(502);
  });
});

function makeEditApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatEditRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    apiToken: 'api_token',
    baseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('PATCH /_kilo/kilo-chat/messages/:id', () => {
  it('rejects without bearer', async () => {
    const app = makeEditApp(async () => new Response('', { status: 200 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/m1', {
        method: 'PATCH',
        body: JSON.stringify({ conversationId: 'c1', text: 'hi', version: 2 }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('forwards authorized PATCH to upstream with rewritten auth and sandbox header', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ messageId: 'm1', version: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeEditApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/m1', {
        method: 'PATCH',
        body: JSON.stringify({ conversationId: 'c1', text: 'Hel', version: 2 }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe('https://chat.example.test/v1/messages/m1');
    expect(capturedInit?.method).toBe('PATCH');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer api_token');
    expect(headers.get('x-kilo-sandbox-id')).toBe(SANDBOX_ID);
    expect(JSON.parse((capturedInit?.body as string) ?? '{}')).toEqual({
      conversationId: 'c1',
      text: 'Hel',
      version: 2,
    });
  });

  it('passes upstream 409 through verbatim', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'stale' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    const app = makeEditApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/m1', {
        method: 'PATCH',
        body: JSON.stringify({ conversationId: 'c1', text: 'x', version: 1 }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      })
    );
    expect(res.status).toBe(409);
  });
});

function makeDeleteApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatDeleteRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    apiToken: 'api_token',
    baseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('DELETE /_kilo/kilo-chat/messages/:id', () => {
  it('rejects without bearer', async () => {
    const app = makeDeleteApp(async () => new Response(null, { status: 204 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/m1', { method: 'DELETE' })
    );
    expect(res.status).toBe(401);
  });

  it('forwards DELETE upstream with rewritten auth', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const app = makeDeleteApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/m1', {
        method: 'DELETE',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(res.status).toBe(204);
    expect(capturedUrl).toBe('https://chat.example.test/v1/messages/m1');
    expect(capturedInit?.method).toBe('DELETE');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer api_token');
    expect(headers.get('x-kilo-sandbox-id')).toBe(SANDBOX_ID);
  });
});
