import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createHttpProxy, handleWebSocketUpgrade } from './proxy';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP proxy', () => {
  it('enforces proxy token when enabled', async () => {
    const app = new Hono();
    app.all('*', createHttpProxy({ expectedToken: 'token-1', requireProxyToken: true }));

    const noToken = await app.request('/x');
    expect(noToken.status).toBe(401);

    const wrongToken = await app.request('/x', { headers: { 'x-kiloclaw-proxy-token': 'bad' } });
    expect(wrongToken.status).toBe(401);
  });

  it('proxies with valid token and strips x-kiloclaw-proxy-token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const app = new Hono();
    app.all(
      '*',
      createHttpProxy({
        expectedToken: 'token-1',
        requireProxyToken: true,
        backendHost: '127.0.0.1',
        backendPort: 3001,
      })
    );

    const resp = await app.request('/test?q=1', {
      headers: { 'x-kiloclaw-proxy-token': 'token-1', 'x-test-header': 'yes' },
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });

    const call = fetchSpy.mock.calls[0];
    expect(call[0].toString()).toBe('http://127.0.0.1:3001/test?q=1');
    const headers = new Headers((call[1] as RequestInit).headers);
    expect(headers.get('x-kiloclaw-proxy-token')).toBeNull();
    expect(headers.get('x-test-header')).toBe('yes');
  });

  it('returns 502 when backend fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('backend down'));

    const app = new Hono();
    app.all('*', createHttpProxy({ expectedToken: 'token-1', requireProxyToken: false }));

    const resp = await app.request('/x');
    expect(resp.status).toBe(502);
    expect(await resp.json()).toEqual({ error: 'Bad Gateway' });
  });

  it('allows passthrough when proxy token is disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    const app = new Hono();
    app.all('*', createHttpProxy({ expectedToken: 'token-1', requireProxyToken: false }));

    const resp = await app.request('/x');
    expect(resp.status).toBe(204);
  });
});

type FakeClientRequest = EventEmitter & {
  end: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => FakeClientRequest;
};

function createIncomingMessage(headers: Record<string, string>): http.IncomingMessage {
  return {
    headers,
    method: 'GET',
    url: '/ws',
  } as http.IncomingMessage;
}

class FakeSocket extends EventEmitter {
  written: string[] = [];
  destroyed = false;
  pipe = vi.fn((dest: unknown) => dest);
  write = vi.fn((chunk: Buffer | string) => {
    this.written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    return true;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    return this;
  });
  end = vi.fn(() => this);
}

describe('WebSocket proxy', () => {
  it('rejects upgrade without proxy token when enforcement is enabled', () => {
    const req = createIncomingMessage({});
    const socket = new FakeSocket() as unknown as Duplex;

    handleWebSocketUpgrade(req, socket, Buffer.alloc(0), {
      expectedToken: 'token-1',
      requireProxyToken: true,
    });

    expect((socket as unknown as FakeSocket).written.join('')).toContain('HTTP/1.1 401');
    expect((socket as unknown as FakeSocket).destroyed).toBe(true);
  });

  it('upgrades with valid token and strips proxy header before forwarding', async () => {
    const req = createIncomingMessage({ 'x-kiloclaw-proxy-token': 'token-1' });
    const clientSocket = new FakeSocket() as unknown as Duplex;
    const backendSocket = new FakeSocket();

    const backendReq = new EventEmitter() as FakeClientRequest;
    let forwardedHeaders: http.OutgoingHttpHeaders | readonly string[] | undefined;
    backendReq.end = () => {
      const backendRes = new EventEmitter() as http.IncomingMessage;
      (backendRes as { statusCode?: number }).statusCode = 101;
      (backendRes as { statusMessage?: string }).statusMessage = 'Switching Protocols';
      (backendRes as { rawHeaders?: string[] }).rawHeaders = [
        'Connection',
        'Upgrade',
        'Upgrade',
        'websocket',
      ];
      backendReq.emit('upgrade', backendRes, backendSocket, Buffer.from('backend-head'));
    };

    vi.spyOn(http, 'request').mockImplementation(((options: http.RequestOptions) => {
      forwardedHeaders = options.headers;
      return backendReq;
    }) as never);

    handleWebSocketUpgrade(req, clientSocket, Buffer.from('client-head'), {
      expectedToken: 'token-1',
      requireProxyToken: true,
    });

    await Promise.resolve();
    expect((clientSocket as unknown as FakeSocket).written.join('')).toContain('HTTP/1.1 101');
    expect(backendSocket.written.join('')).toContain('client-head');
    expect((clientSocket as unknown as FakeSocket).written.join('')).toContain('backend-head');
    const forwarded = forwardedHeaders as http.OutgoingHttpHeaders | undefined;
    expect(forwarded?.['x-kiloclaw-proxy-token']).toBeUndefined();
    expect((clientSocket as unknown as FakeSocket).pipe).toHaveBeenCalledWith(backendSocket);
    expect(backendSocket.pipe).toHaveBeenCalledWith(clientSocket);
  });
});
