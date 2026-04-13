import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { registerKiloChatSendRoute } from './kilo-chat';

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
    const fetchImpl = (async () =>
      new Response('bad', { status: 502 })) as typeof fetch;
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
