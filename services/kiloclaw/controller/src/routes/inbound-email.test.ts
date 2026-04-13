import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { SupervisorState } from '../supervisor';
import { registerInboundEmailRoute } from './inbound-email';

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

describe('registerInboundEmailRoute', () => {
  let app: Hono;
  const GATEWAY_TOKEN = 'gateway-token-abc';
  const HOOKS_TOKEN = 'hooks-token-xyz';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    app = new Hono();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 without gateway auth', async () => {
    const supervisor = createMockSupervisor();
    registerInboundEmailRoute(app, supervisor, GATEWAY_TOKEN, HOOKS_TOKEN);

    const res = await app.request('/_kilo/hooks/email', {
      method: 'POST',
      body: JSON.stringify({ messageId: 'msg-1' }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 503 when gateway is not running', async () => {
    const supervisor = createMockSupervisor('stopped');
    registerInboundEmailRoute(app, supervisor, GATEWAY_TOKEN, HOOKS_TOKEN);

    const res = await app.request('/_kilo/hooks/email', {
      method: 'POST',
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({ messageId: 'msg-1' }),
    });

    expect(res.status).toBe(503);
  });

  it('forwards to the local OpenClaw hook endpoint with hooks token', async () => {
    const supervisor = createMockSupervisor('running');
    registerInboundEmailRoute(app, supervisor, GATEWAY_TOKEN, HOOKS_TOKEN);

    const mockFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', mockFetch);

    const res = await app.request('/_kilo/hooks/email', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ messageId: 'msg-1', text: 'hello' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hookStatus: 200 });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3001/hooks/email');
    expect(init.headers.authorization).toBe(`Bearer ${HOOKS_TOKEN}`);
  });

  it('propagates hook 4xx as permanent failure', async () => {
    const supervisor = createMockSupervisor('running');
    registerInboundEmailRoute(app, supervisor, GATEWAY_TOKEN, HOOKS_TOKEN);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 422 })));

    const res = await app.request('/_kilo/hooks/email', {
      method: 'POST',
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({ messageId: 'msg-1' }),
    });

    expect(res.status).toBe(422);
  });

  it('returns 500 on hook 5xx', async () => {
    const supervisor = createMockSupervisor('running');
    registerInboundEmailRoute(app, supervisor, GATEWAY_TOKEN, HOOKS_TOKEN);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { status: 500 })));

    const res = await app.request('/_kilo/hooks/email', {
      method: 'POST',
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}` },
      body: JSON.stringify({ messageId: 'msg-1' }),
    });

    expect(res.status).toBe(500);
  });
});
