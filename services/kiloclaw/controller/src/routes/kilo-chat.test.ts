import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  registerKiloChatSendRoute,
  registerKiloChatEditRoute,
  registerKiloChatDeleteRoute,
  registerKiloChatTypingRoute,
  registerKiloChatReactionPostRoute,
  registerKiloChatReactionDeleteRoute,
  registerKiloChatListMessagesRoute,
  registerKiloChatGetMembersRoute,
  registerKiloChatRenameRoute,
  registerKiloChatListConversationsRoute,
  registerKiloChatCreateConversationRoute,
} from './kilo-chat';

const TOKEN = 'expected-gateway-token';
const SANDBOX_ID = 'sbx_test';

function makeApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatSendRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    kiloChatBaseUrl: 'https://chat.example.test',
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

  it('forwards authorized requests to the kilo-chat worker with the same bearer', async () => {
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
    expect(capturedUrl).toBe('https://chat.example.test/bot/v1/sandboxes/sbx_test/messages');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
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
    kiloChatBaseUrl: 'https://chat.example.test',
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

  it('forwards authorized PATCH to the kilo-chat worker with the same bearer', async () => {
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
    expect(capturedUrl).toBe('https://chat.example.test/bot/v1/sandboxes/sbx_test/messages/m1');
    expect(capturedInit?.method).toBe('PATCH');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
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
    kiloChatBaseUrl: 'https://chat.example.test',
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

  it('forwards DELETE upstream with query params and rewritten auth', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const app = makeDeleteApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/m1?conversationId=c1', {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(res.status).toBe(204);
    expect(capturedUrl).toBe(
      'https://chat.example.test/bot/v1/sandboxes/sbx_test/messages/m1?conversationId=c1'
    );
    expect(capturedInit?.method).toBe('DELETE');
    expect(capturedInit?.body).toBeUndefined();
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
  });
});

function makeTypingApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatTypingRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    kiloChatBaseUrl: 'https://chat.example.test',
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

  it('forwards to kilo-chat worker typing path with gateway bearer', async () => {
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
      'https://chat.example.test/bot/v1/sandboxes/sbx_test/conversations/c1/typing'
    );
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
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
      'https://chat.example.test/bot/v1/sandboxes/sbx_test/conversations/a%20b%2Fc/typing'
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
  it('proxies to the kilo-chat worker with gateway bearer, forwards body + status', async () => {
    const app = new Hono();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'RXULIDXXX' }), { status: 201 });
    }) as typeof fetch;

    registerKiloChatReactionPostRoute(app, {
      expectedToken: 'gw',
      sandboxId: 'sbx',
      kiloChatBaseUrl: 'http://svc',
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
    expect(calls[0].url).toBe('http://svc/bot/v1/sandboxes/sbx/messages/MID/reactions');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gw');
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
      kiloChatBaseUrl: 'http://svc',
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
      kiloChatBaseUrl: 'http://svc',
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
      kiloChatBaseUrl: 'http://svc',
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
  it('proxies DELETE with query params forwarded to upstream; forwards 204', async () => {
    const app = new Hono();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    registerKiloChatReactionDeleteRoute(app, {
      expectedToken: 'gw',
      sandboxId: 'sbx',
      kiloChatBaseUrl: 'http://svc',
      fetchImpl,
    });

    const qs = new URLSearchParams({ conversationId: 'C', emoji: '\u{1F44D}' });
    const res = await app.fetch(
      new Request(`http://x/_kilo/kilo-chat/messages/MID/reactions?${qs}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer gw' },
      })
    );
    expect(res.status).toBe(204);
    expect(calls[0].init.method).toBe('DELETE');
    const upstreamUrl = new URL(calls[0].url);
    expect(upstreamUrl.pathname).toBe('/bot/v1/sandboxes/sbx/messages/MID/reactions');
    expect(upstreamUrl.searchParams.get('conversationId')).toBe('C');
    expect(upstreamUrl.searchParams.get('emoji')).toBe('\u{1F44D}');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gw');
  });

  it('401 on missing bearer', async () => {
    const app = new Hono();
    registerKiloChatReactionDeleteRoute(app, {
      expectedToken: 'gw',
      sandboxId: 's',
      kiloChatBaseUrl: 'http://svc',
      fetchImpl: (async () => new Response()) as typeof fetch,
    });
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/messages/MID/reactions', { method: 'DELETE' })
    );
    expect(res.status).toBe(401);
  });
});

describe('upstream network errors return 502', () => {
  it('send route returns 502 when upstream fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
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
    expect(res.status).toBe(502);
  });

  it('typing route returns 502 when upstream fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
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
    expect(res.status).toBe(502);
  });
});

describe('upstream timeout', () => {
  it('send route returns 504 when upstream takes longer than the configured timeout', async () => {
    const fetchImpl = ((_url: string | URL, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const reason = init.signal?.reason;
          reject(reason instanceof Error ? reason : new DOMException('aborted', 'AbortError'));
        });
      });
    }) as typeof fetch;

    const app = new Hono();
    registerKiloChatSendRoute(app, {
      expectedToken: TOKEN,
      sandboxId: SANDBOX_ID,
      kiloChatBaseUrl: 'https://chat.example.test',
      fetchImpl,
      upstreamTimeoutMs: 10,
    });

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
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Gateway Timeout');
  });
});

describe('body size limits', () => {
  function makeApp(register: typeof registerKiloChatSendRoute, fetchImpl: typeof fetch) {
    const app = new Hono();
    register(app, {
      expectedToken: TOKEN,
      sandboxId: SANDBOX_ID,
      kiloChatBaseUrl: 'https://chat.example.test',
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

function makeListMessagesApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatListMessagesRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    kiloChatBaseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('GET /_kilo/kilo-chat/conversations/:conversationId/messages', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeListMessagesApp(async () => new Response('[]', { status: 200 }));
    const res = await app.fetch(new Request('http://x/_kilo/kilo-chat/conversations/c1/messages'));
    expect(res.status).toBe(401);
  });

  it('forwards to correct upstream URL with gateway bearer', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify([{ id: 'm1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeListMessagesApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/c1/messages', {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      'https://chat.example.test/bot/v1/sandboxes/sbx_test/conversations/c1/messages'
    );
    expect(capturedInit?.method).toBe('GET');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
  });

  it('passes query string through to upstream', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeListMessagesApp(fetchImpl);
    await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/c1/messages?before=msg123&limit=50', {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    );

    expect(capturedUrl).toBe(
      'https://chat.example.test/bot/v1/sandboxes/sbx_test/conversations/c1/messages?before=msg123&limit=50'
    );
  });
});

function makeMembersApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatGetMembersRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    kiloChatBaseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('GET /_kilo/kilo-chat/conversations/:conversationId/members', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeMembersApp(async () => new Response('[]', { status: 200 }));
    const res = await app.fetch(new Request('http://x/_kilo/kilo-chat/conversations/c1/members'));
    expect(res.status).toBe(401);
  });

  it('forwards to correct upstream URL with gateway bearer', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify([{ userId: 'u1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeMembersApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/c1/members', {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      'https://chat.example.test/bot/v1/sandboxes/sbx_test/conversations/c1/members'
    );
    expect(capturedInit?.method).toBe('GET');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
  });
});

function makeRenameApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatRenameRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    kiloChatBaseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('PATCH /_kilo/kilo-chat/conversations/:conversationId', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeRenameApp(async () => new Response('', { status: 200 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/c1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'New name' }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('forwards authorized PATCH to the kilo-chat worker with correct URL and body', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeRenameApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/c1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'New name' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      'https://chat.example.test/bot/v1/sandboxes/sbx_test/conversations/c1'
    );
    expect(capturedInit?.method).toBe('PATCH');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
    expect(JSON.parse((capturedInit?.body as string) ?? '{}')).toEqual({ title: 'New name' });
  });

  it('returns 502 when upstream fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const app = makeRenameApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations/c1', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'New name' }),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );
    expect(res.status).toBe(502);
  });
});

function makeListConversationsApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatListConversationsRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    kiloChatBaseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('GET /_kilo/kilo-chat/conversations', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeListConversationsApp(async () => new Response('[]', { status: 200 }));
    const res = await app.fetch(new Request('http://x/_kilo/kilo-chat/conversations'));
    expect(res.status).toBe(401);
  });

  it('forwards to correct upstream URL with gateway bearer', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ conversations: [], total: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeListConversationsApp(fetchImpl);
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations', {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    );

    expect(res.status).toBe(200);
    expect(capturedUrl).toBe(
      `https://chat.example.test/bot/v1/sandboxes/${SANDBOX_ID}/conversations`
    );
    expect(capturedInit?.method).toBe('GET');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
  });

  it('passes query string through to upstream', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      return new Response(JSON.stringify({ conversations: [], total: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeListConversationsApp(fetchImpl);
    await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations?limit=10&offset=5', {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
    );

    expect(capturedUrl).toBe(
      `https://chat.example.test/bot/v1/sandboxes/${SANDBOX_ID}/conversations?limit=10&offset=5`
    );
  });
});

function makeCreateConversationApp(fetchImpl: typeof fetch) {
  const app = new Hono();
  registerKiloChatCreateConversationRoute(app, {
    expectedToken: TOKEN,
    sandboxId: SANDBOX_ID,
    kiloChatBaseUrl: 'https://chat.example.test',
    fetchImpl,
  });
  return app;
}

describe('POST /_kilo/kilo-chat/conversations', () => {
  it('rejects requests without bearer token', async () => {
    const app = makeCreateConversationApp(async () => new Response('', { status: 201 }));
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'Test' }),
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(401);
  });

  it('forwards authorized POST to upstream with correct URL', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = typeof url === 'string' ? url : url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ conversationId: 'new-conv-1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const app = makeCreateConversationApp(fetchImpl);
    const body = JSON.stringify({ title: 'Bot Chat' });
    const res = await app.fetch(
      new Request('http://x/_kilo/kilo-chat/conversations', {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
        },
      })
    );

    expect(res.status).toBe(201);
    expect(capturedUrl).toBe(
      `https://chat.example.test/bot/v1/sandboxes/${SANDBOX_ID}/conversations`
    );
    expect(capturedInit?.method).toBe('POST');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer ' + TOKEN);
  });
});
