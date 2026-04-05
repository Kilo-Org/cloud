import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { SupervisorState } from '../supervisor';
import { registerGmailPushRoute } from './gmail-push';

function createMockSupervisor(state: SupervisorState = 'running') {
  return {
    getState: vi.fn(() => state),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    shutdown: vi.fn(),
    signal: vi.fn(),
    getStats: vi.fn(),
  };
}

describe('registerGmailPushRoute', () => {
  let app: Hono;
  const TOKEN = 'test-token-abc';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    app = new Hono();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when gmail watch supervisor is null', async () => {
    registerGmailPushRoute(app, null, TOKEN);
    const res = await app.request('/_kilo/gmail-pubsub', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const supervisor = createMockSupervisor();
    registerGmailPushRoute(app, supervisor, TOKEN);
    const res = await app.request('/_kilo/gmail-pubsub', {
      method: 'POST',
      body: JSON.stringify({ message: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 when gmail watch is not running', async () => {
    const supervisor = createMockSupervisor('stopped');
    registerGmailPushRoute(app, supervisor, TOKEN);
    const res = await app.request('/_kilo/gmail-pubsub', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: {} }),
    });
    expect(res.status).toBe(503);
  });

  it('proxies to localhost:3002 and returns 200 on success', async () => {
    const supervisor = createMockSupervisor('running');
    registerGmailPushRoute(app, supervisor, TOKEN);

    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const body = JSON.stringify({ message: { data: 'dGVzdA==', messageId: '123' } });
    const res = await app.request('/_kilo/gmail-pubsub', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, gogStatus: 200 });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3002/gmail-pubsub');
  });

  it('propagates 202 from gog (no new messages)', async () => {
    const supervisor = createMockSupervisor('running');
    registerGmailPushRoute(app, supervisor, TOKEN);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('no new messages', { status: 202 }))
    );

    const res = await app.request('/_kilo/gmail-pubsub', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: {} }),
    });

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json).toEqual({ ok: true, gogStatus: 202 });
  });

  it('returns 200 on 4xx from downstream (permanently rejected)', async () => {
    const supervisor = createMockSupervisor('running');
    registerGmailPushRoute(app, supervisor, TOKEN);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 400 })));

    const res = await app.request('/_kilo/gmail-pubsub', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: {} }),
    });

    expect(res.status).toBe(200);
  });

  it('returns 500 on 5xx from downstream (triggers Pub/Sub retry)', async () => {
    const supervisor = createMockSupervisor('running');
    registerGmailPushRoute(app, supervisor, TOKEN);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 500 })));

    const res = await app.request('/_kilo/gmail-pubsub', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: {} }),
    });

    expect(res.status).toBe(500);
  });

  it('returns 500 on network error (triggers Pub/Sub retry)', async () => {
    const supervisor = createMockSupervisor('running');
    registerGmailPushRoute(app, supervisor, TOKEN);

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const res = await app.request('/_kilo/gmail-pubsub', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message: {} }),
    });

    expect(res.status).toBe(500);
  });
});
