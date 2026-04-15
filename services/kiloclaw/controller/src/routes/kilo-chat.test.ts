import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  registerKiloChatSendRoute,
  registerKiloChatEditRoute,
  registerKiloChatDeleteRoute,
  registerKiloChatTypingRoute,
  registerKiloChatReactionPostRoute,
  registerKiloChatReactionDeleteRoute,
} from './kilo-chat';

const TOKEN = 'expected-gateway-token';
const SANDBOX_ID = 'sbx_test';

function makeApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatSendRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    /* replaced by kiloclawBaseUrl */
    kiloclawBaseUrl: 'https://claw.example.test',
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
    expect(capturedUrl).toBe('https://claw.example.test/api/kilo-chat/sandboxes/sbx_test/messages');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
    expect(headers.get('x-kilo-sandbox-id')).toBeNull();
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
    /* replaced by kiloclawBaseUrl */
    kiloclawBaseUrl: 'https://claw.example.test',
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
    expect(capturedUrl).toBe(
      'https://claw.example.test/api/kilo-chat/sandboxes/sbx_test/messages/m1'
    );
    expect(capturedInit?.method).toBe('PATCH');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
    expect(headers.get('x-kilo-sandbox-id')).toBeNull();
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
    /* replaced by kiloclawBaseUrl */
    kiloclawBaseUrl: 'https://claw.example.test',
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
    expect(capturedUrl).toBe(
      'https://claw.example.test/api/kilo-chat/sandboxes/sbx_test/messages/m1'
    );
    expect(capturedInit?.method).toBe('DELETE');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
    expect(headers.get('x-kilo-sandbox-id')).toBeNull();
  });
});

function makeTypingApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatTypingRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    /* replaced by kiloclawBaseUrl */
    kiloclawBaseUrl: 'https://claw.example.test',
    fetchImpl,
  });
  return app;
}

describe('POST /_kilo/kilo-chat/typing', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeTypingApp(async () => new Response(null, { status: 204 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const app = makeTypingApp(async () => new Response(null, { status: 204 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong',
        },
      })
    );
    expect(res.status).toBe(401);
  });

  it('forwards to kiloclaw worker typing path with gateway bearer', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const app = makeTypingApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );

    expect(res.status).toBe(204);
    expect(capturedUrl).toBe(
      'https://claw.example.test/api/kilo-chat/sandboxes/sbx_test/conversations/c1/typing'
    );
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
    expect(headers.get('x-kilo-sandbox-id')).toBeNull();
    expect(capturedInit?.method).toBe('POST');
  });

  it('url-encodes the conversation id', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const app = makeTypingApp(fetchImpl);
    await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'a b/c' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(capturedUrl).toBe(
      'https://claw.example.test/api/kilo-chat/sandboxes/sbx_test/conversations/a%20b%2Fc/typing'
    );
  });

  it('rejects body missing conversationId with 400', async () => {
    const app = makeTypingApp(async () => new Response(null, { status: 204 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(res.status).toBe(400);
  });

  it('passes upstream non-2xx status through', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 502 })) as typeof fetch;
    const app = makeTypingApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        body: JSON.stringify({ conversationId: 'c1' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(res.status).toBe(502);
  });
});

describe('POST /_kilo/kilo-chat/messages/:id/reactions', () => {
  it('proxies to service with auth + sandbox header, forwards body + status', async () => {
    const app = new Hono();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'RXULIDXXX' }), { status: 201 });
    }) as typeof fetch;

    registerKiloChatReactionPostRoute(app, {
      expectedToken: 'gw',
      sandboxId: 'sbx',
      /* replaced */
      kiloclawBaseUrl: 'http://svc',
      fetchImpl,
    });

    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/MID/reactions', {
        method: 'POST',
        headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'C', emoji: '\u{1F44D}' }),
      })
    );
    expect(res.status).toBe(201);
    expect(calls[0].url).toBe('http://svc/api/kilo-chat/sandboxes/sbx/messages/MID/reactions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gw');
    expect(headers['x-kilo-sandbox-id']).toBeUndefined();
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBe(JSON.stringify({ conversationId: 'C', emoji: '\u{1F44D}' }));
  });

  it('passes through 200 dedupe status', async () => {
    const app = new Hono();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: 'RXULIDXXX' }), { status: 200 })) as typeof fetch;
    registerKiloChatReactionPostRoute(app, {
      expectedToken: 'gw',
      sandboxId: 's',
      /* replaced */
      kiloclawBaseUrl: 'http://svc',
      fetchImpl,
    });
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/MID/reactions', {
        method: 'POST',
        headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'C', emoji: '\u{1F44D}' }),
      })
    );
    expect(res.status).toBe(200);
  });

  it('401 on missing bearer token', async () => {
    const app = new Hono();
    registerKiloChatReactionPostRoute(app, {
      expectedToken: 'gw',
      sandboxId: 's',
      /* replaced */
      kiloclawBaseUrl: 'http://svc',
      fetchImpl: (async () => new Response()) as typeof fetch,
    });
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/MID/reactions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    );
    expect(res.status).toBe(401);
  });

  it('401 on wrong bearer token', async () => {
    const app = new Hono();
    registerKiloChatReactionPostRoute(app, {
      expectedToken: 'gw',
      sandboxId: 's',
      /* replaced */
      kiloclawBaseUrl: 'http://svc',
      fetchImpl: (async () => new Response()) as typeof fetch,
    });
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/MID/reactions', {
        method: 'POST',
        headers: { authorization: 'Bearer WRONG', 'content-type': 'application/json' },
        body: '{}',
      })
    );
    expect(res.status).toBe(401);
  });
});

describe('DELETE /_kilo/kilo-chat/messages/:id/reactions', () => {
  it('proxies DELETE with auth + sandbox header; forwards 204', async () => {
    const app = new Hono();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    registerKiloChatReactionDeleteRoute(app, {
      expectedToken: 'gw',
      sandboxId: 'sbx',
      /* replaced */
      kiloclawBaseUrl: 'http://svc',
      fetchImpl,
    });

    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/MID/reactions', {
        method: 'DELETE',
        headers: { authorization: 'Bearer gw', 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: 'C', emoji: '\u{1F44D}' }),
      })
    );
    expect(res.status).toBe(204);
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toBe('http://svc/api/kilo-chat/sandboxes/sbx/messages/MID/reactions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gw');
    expect(headers['x-kilo-sandbox-id']).toBeUndefined();
  });

  it('401 on missing bearer', async () => {
    const app = new Hono();
    registerKiloChatReactionDeleteRoute(app, {
      expectedToken: 'gw',
      sandboxId: 's',
      /* replaced */
      kiloclawBaseUrl: 'http://svc',
      fetchImpl: (async () => new Response()) as typeof fetch,
    });
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/MID/reactions', { method: 'DELETE' })
    );
    expect(res.status).toBe(401);
  });
});

describe('body size limits', () => {
  function makeApp(register: typeof registerKiloChatSendRoute, fetchImpl: typeof fetch) {
    const app = new Hono();
    register(app, {
      expectedToken: TOKEN,
      sandboxId: SANDBOX_ID,
      /* replaced by kiloclawBaseUrl */
      kiloclawBaseUrl: 'https://claw.example.test',
      fetchImpl,
    });
    return app;
  }

  it('send route rejects bodies larger than the 1 MB cap with 413', async () => {
    let upstreamCalled = false;
    const fetchImpl = (async () => {
      upstreamCalled = true;
      return new Response('{}', { status: 201 });
    }) as typeof fetch;
    const app = makeApp(registerKiloChatSendRoute, fetchImpl);

    const oversizedBody = 'x'.repeat(1 * 1024 * 1024 + 10);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': String(oversizedBody.length),
        },
        body: oversizedBody,
      })
    );
    expect(res.status).toBe(413);
    expect(upstreamCalled).toBe(false);
  });

  it('typing route rejects bodies larger than the small cap with 413', async () => {
    let upstreamCalled = false;
    const fetchImpl = (async () => {
      upstreamCalled = true;
      return new Response('{}', { status: 204 });
    }) as typeof fetch;
    const app = makeApp(registerKiloChatTypingRoute, fetchImpl);

    const oversizedBody = JSON.stringify({ conversationId: 'c1', padding: 'x'.repeat(16 * 1024) });
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/typing', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': String(oversizedBody.length),
        },
        body: oversizedBody,
      })
    );
    expect(res.status).toBe(413);
    expect(upstreamCalled).toBe(false);
  });
});
