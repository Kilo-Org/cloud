import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  createPreviewForwarder,
  type PreviewForwarder,
  type PreviewHttpRequest,
} from './preview-forwarder.js';

const RESERVED_PORT = 23456;
const BIG_BYTES = 64 * 1024 * 1024;

type Seen = { headers: Record<string, string>; bodyBytes: number; url: string };

let forwarder: PreviewForwarder;
let ipv4: Bun.Server<undefined>;
let ipv6: Bun.Server<undefined>;
let kiloLike: Bun.Server<undefined>;
let silent: Bun.Server<undefined>;
let closedPort: number;
let lastSeen: Seen | undefined;
let releaseSecondChunk: (() => void) | undefined;
const releaseSilent = Promise.withResolvers<void>();

function portOf(server: Bun.Server<unknown>): number {
  if (server.port === undefined) throw new Error('server has no TCP port');
  return server.port;
}

async function appFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const body = request.body === null ? new ArrayBuffer(0) : await request.arrayBuffer();
  lastSeen = {
    headers: Object.fromEntries(request.headers),
    bodyBytes: body.byteLength,
    url: `${url.pathname}${url.search}`,
  };
  if (url.pathname === '/big') return new Response(new Uint8Array(BIG_BYTES));
  if (url.pathname === '/redirect') {
    return new Response(null, { status: 302, headers: { location: '/next' } });
  }
  if (url.pathname === '/empty') return new Response(null, { status: 204 });
  if (url.pathname === '/events') {
    const encoder = new TextEncoder();
    const second = new Promise<void>(resolve => {
      releaseSecondChunk = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: one\n\n'));
        await second;
        controller.enqueue(encoder.encode('data: two\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
  const headers = new Headers({ 'x-kilo-preview-port': '1', 'content-type': 'text/plain' });
  headers.append('set-cookie', 'a=1; Path=/');
  headers.append('set-cookie', 'b=2; Path=/');
  return new Response(`hello from ${url.pathname}`, { headers });
}

const echoSocket = {
  open(ws: Bun.ServerWebSocket<undefined>) {
    // Sent at once: it must reach the caller after `openSocket` resolves.
    ws.send('welcome');
  },
  message(ws: Bun.ServerWebSocket<undefined>, message: string | Buffer) {
    if (message === 'close-4000') {
      ws.close(4000, 'app closed');
      return;
    }
    ws.send(typeof message === 'string' ? `echo:${message}` : message);
  },
};

function websocketFetch(request: Request, server: Bun.Server<undefined>): Response | undefined {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return undefined;
  const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',');
  const chosen = offered.map(item => item.trim()).find(item => item === 'vite-hmr');
  lastSeen = { headers: Object.fromEntries(request.headers), bodyBytes: 0, url: request.url };
  const upgraded = server.upgrade(request, {
    data: undefined,
    ...(chosen ? { headers: { 'sec-websocket-protocol': chosen } } : {}),
  });
  return upgraded ? undefined : new Response('upgrade failed', { status: 400 });
}

function get(port: number, path = '/', headers: Record<string, string> = {}): PreviewHttpRequest {
  return {
    port,
    method: 'GET',
    path,
    headers: new Headers(headers),
    body: null,
    signal: new AbortController().signal,
  };
}

async function response(request: PreviewHttpRequest): Promise<Response> {
  const result = await forwarder.fetch(request);
  if (!result.ok) throw new Error(`forward failed: ${result.reason}`);
  return result.value;
}

beforeAll(async () => {
  ipv4 = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch: (request, server) => websocketFetch(request, server) ?? appFetch(request),
    websocket: echoSocket,
  });
  ipv6 = Bun.serve({
    hostname: '::1',
    port: 0,
    fetch: (request, server) => websocketFetch(request, server) ?? appFetch(request),
    websocket: echoSocket,
  });
  kiloLike = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('kilo') });
  silent = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    fetch: async () => {
      await releaseSilent.promise;
      return new Response('late');
    },
  });
  const closed = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') });
  closedPort = portOf(closed);
  await closed.stop(true);
  forwarder = createPreviewForwarder({
    refusedPorts: () => [RESERVED_PORT, portOf(kiloLike)],
    headTimeoutMs: 300,
    socketTimeoutMs: 300,
  });
});

afterAll(() => {
  releaseSilent.resolve();
  // Bun's `stop(true)` promise does not settle once a server has served a WebSocket.
  for (const server of [ipv4, ipv6, kiloLike, silent]) void server.stop(true);
});

describe('preview forwarder refusals', () => {
  it.each([
    ['a reserved port', () => RESERVED_PORT],
    ['a Kilo port', () => portOf(kiloLike)],
    ['a port below the preview range', () => 80],
    ['a port above the preview range', () => 70_000],
  ])('refuses %s', async (_name, port) => {
    expect(await forwarder.fetch(get(port()))).toEqual({ ok: false, reason: 'reserved' });
    const socket = await forwarder.openSocket({
      port: port(),
      path: '/',
      headers: new Headers(),
      protocols: [],
    });
    expect(socket).toEqual({ ok: false, reason: 'reserved' });
  });

  it('refuses a path that does not start with a slash', async () => {
    const result = await forwarder.fetch(get(portOf(ipv4), 'evil.example/x'));
    expect(result).toEqual({ ok: false, reason: 'invalid' });
  });

  it('keeps a path that looks like a host on loopback', async () => {
    const forwarded = await response(get(portOf(ipv4), '//evil.example/x?q=1'));
    // The loopback server got it; Bun's server folds the double slash.
    expect(forwarded.status).toBe(200);
    expect(lastSeen?.url).toMatch(/^\/+evil\.example\/x\?q=1$/);
  });

  it('reports a port with nothing listening', async () => {
    expect(await forwarder.fetch(get(closedPort))).toEqual({ ok: false, reason: 'not_listening' });
  });

  it('reports an upstream that sends no headers in time', async () => {
    expect(await forwarder.fetch(get(portOf(silent)))).toEqual({ ok: false, reason: 'timeout' });
  });
});

describe('preview forwarder HTTP', () => {
  it('forwards to a 127.0.0.1 server with normalized headers', async () => {
    const port = portOf(ipv4);
    const forwarded = await response(
      get(port, '/page?q=1', {
        origin: 'https://preview.example',
        'x-forwarded-for': '198.51.100.1',
        'x-real-ip': '198.51.100.1',
        'x-kilo-preview-allocation': 'spoofed',
        forwarded: 'for=198.51.100.1',
        'accept-encoding': 'br, gzip',
        cookie: 'app=1',
      })
    );
    expect(forwarded.status).toBe(200);
    expect(await forwarded.text()).toBe('hello from /page');
    const seen = lastSeen?.headers ?? {};
    expect(lastSeen?.url).toBe('/page?q=1');
    expect(seen.host).toBe(`localhost:${port}`);
    expect(seen.origin).toBe(`http://localhost:${port}`);
    expect(seen['accept-encoding']).toBe('identity');
    expect(seen.cookie).toBe('app=1');
    for (const name of Object.keys(seen)) {
      expect(name.startsWith('x-kilo-preview-')).toBe(false);
      expect(name.startsWith('x-forwarded-')).toBe(false);
    }
    expect(seen['x-real-ip']).toBeUndefined();
    expect(seen.forwarded).toBeUndefined();
  });

  it('strips app-sent markers and keeps every cookie', async () => {
    const forwarded = await response(get(portOf(ipv4)));
    expect(forwarded.headers.get('x-kilo-preview-port')).toBeNull();
    expect(forwarded.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('forwards to a server bound to ::1 only', async () => {
    const forwarded = await response(get(portOf(ipv6), '/v6'));
    expect(await forwarded.text()).toBe('hello from /v6');
  });

  it('passes a redirect back without following it', async () => {
    const forwarded = await response(get(portOf(ipv4), '/redirect'));
    expect(forwarded.status).toBe(302);
    expect(forwarded.headers.get('location')).toBe('/next');
  });

  it('gives no body for a status without one', async () => {
    const forwarded = await response(get(portOf(ipv4), '/empty'));
    expect(forwarded.status).toBe(204);
    expect(forwarded.body).toBeNull();
  });

  it('streams an event stream chunk by chunk', async () => {
    const forwarded = await response(get(portOf(ipv4), '/events'));
    const reader = (forwarded.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe('data: one\n\n');
    releaseSecondChunk?.();
    let rest = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      rest += decoder.decode(next.value);
    }
    expect(rest).toBe('data: two\n\n');
  });

  it('carries a 64 MiB upload and a 64 MiB download', async () => {
    // The head deadline covers the upload, so the short shared deadline fails on a loaded runner.
    const bulkForwarder = createPreviewForwarder({
      refusedPorts: () => [RESERVED_PORT],
      headTimeoutMs: 20_000,
      socketTimeoutMs: 300,
    });
    const bulkResponse = async (request: PreviewHttpRequest): Promise<Response> => {
      const result = await bulkForwarder.fetch(request);
      if (!result.ok) throw new Error(`forward failed: ${result.reason}`);
      return result.value;
    };
    const upload = await bulkResponse({
      ...get(portOf(ipv4), '/upload'),
      method: 'POST',
      body: new Response(new Uint8Array(BIG_BYTES)).body,
    });
    expect(upload.status).toBe(200);
    await upload.arrayBuffer();
    expect(lastSeen?.bodyBytes).toBe(BIG_BYTES);

    const download = await bulkResponse(get(portOf(ipv4), '/big'));
    expect((await download.arrayBuffer()).byteLength).toBe(BIG_BYTES);
  }, 30_000);
});

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise(resolve => {
    socket.addEventListener('message', event => resolve(event.data), { once: true });
  });
}

describe('preview forwarder WebSocket', () => {
  it('opens with the subprotocol the app chose and carries close codes', async () => {
    const result = await forwarder.openSocket({
      port: portOf(ipv4),
      path: '/hmr',
      headers: new Headers({ 'x-kilo-preview-port': '1', origin: 'https://preview.example' }),
      protocols: ['other', 'vite-hmr'],
    });
    if (!result.ok) throw new Error(`open failed: ${result.reason}`);
    const socket = result.value;
    expect(await nextMessage(socket)).toBe('welcome');
    expect(socket.protocol).toBe('vite-hmr');
    expect(lastSeen?.headers['x-kilo-preview-port']).toBeUndefined();
    expect(lastSeen?.headers.origin).toBe(`http://localhost:${portOf(ipv4)}`);

    const text = nextMessage(socket);
    socket.send('ping');
    expect(await text).toBe('echo:ping');

    const binary = nextMessage(socket);
    socket.send(new Uint8Array([1, 2, 3]));
    expect([...new Uint8Array((await binary) as ArrayBuffer)]).toEqual([1, 2, 3]);

    const closed = new Promise<CloseEvent>(resolve => {
      socket.addEventListener('close', event => resolve(event), { once: true });
    });
    socket.send('close-4000');
    const event = await closed;
    expect(event.code).toBe(4000);
    expect(event.reason).toBe('app closed');
  });

  it('opens on a server bound to ::1 only', async () => {
    const result = await forwarder.openSocket({
      port: portOf(ipv6),
      path: '/hmr',
      headers: new Headers(),
      protocols: [],
    });
    if (!result.ok) throw new Error(`open failed: ${result.reason}`);
    expect(await nextMessage(result.value)).toBe('welcome');
    result.value.close();
  });

  it('reports a port with nothing listening', async () => {
    const result = await forwarder.openSocket({
      port: closedPort,
      path: '/',
      headers: new Headers(),
      protocols: [],
    });
    expect(result).toEqual({ ok: false, reason: 'not_listening' });
  });
});
