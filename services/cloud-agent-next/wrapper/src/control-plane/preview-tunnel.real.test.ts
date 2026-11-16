import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  PREVIEW_TUNNEL_DATA_MAX_BYTES,
  PREVIEW_TUNNEL_WINDOW_BYTES,
  PREVIEW_TUNNEL_WS_ID_BASE,
  type PreviewTunnelFrame,
} from '../../../src/shared/preview-tunnel-protocol.js';
import { createPreviewForwarder } from './preview-forwarder.js';
import { startFakeTunnelWorker, type FakeTunnelWorker } from './preview-tunnel-fixture.js';
import {
  createPreviewTunnelClient,
  type PreviewTunnelClient,
  type PreviewTunnelLimits,
  type TunnelSocket,
} from './preview-tunnel.js';

const BIG_BYTES = 64 * 1024 * 1024;
const UPLOAD_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function pattern(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  return bytes;
}

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const BIG = pattern(BIG_BYTES);
const BIG_SHA = sha(BIG);

let devServer: Bun.Server<undefined>;
let refusedServer: Bun.Server<undefined>;
let closedPort: number;
let releaseHead = Promise.withResolvers<void>();
let abortedRequests = 0;
let devRequests: string[] = [];
let upstreamCloses: number[] = [];
let worker: FakeTunnelWorker | undefined;
let client: PreviewTunnelClient | undefined;

function portOf(server: Bun.Server<unknown>): number {
  if (server.port === undefined) throw new Error('server has no TCP port');
  return server.port;
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('until timed out');
    await Bun.sleep(5);
  }
}

beforeAll(() => {
  devServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request, server) {
      const url = new URL(request.url);
      devRequests.push(url.pathname);
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',');
        const chosen = offered.map(item => item.trim()).find(item => item === 'vite-hmr');
        const headers = chosen === undefined ? undefined : { 'Sec-WebSocket-Protocol': chosen };
        return server.upgrade(request, { headers })
          ? undefined
          : new Response('no upgrade', { status: 400 });
      }
      switch (url.pathname) {
        case '/hello': {
          const headers = new Headers({ 'content-type': 'text/plain', 'x-kilo-preview-port': '1' });
          headers.append('set-cookie', 'a=1; Path=/');
          headers.append('set-cookie', 'b=2; Path=/');
          return new Response('hello', { headers });
        }
        case '/big':
          return new Response(BIG);
        case '/slow-head':
          await releaseHead.promise;
          return new Response('late');
        case '/upload': {
          const body = new Uint8Array(await request.arrayBuffer());
          return Response.json({ bytes: body.byteLength, sha: sha(body) });
        }
        case '/hang-body':
          request.signal.addEventListener('abort', () => {
            abortedRequests += 1;
          });
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(encoder.encode('first'));
              },
            })
          );
        case '/empty':
          return new Response(null, { status: 204 });
        default:
          return new Response('missing', { status: 404 });
      }
    },
    websocket: {
      open(ws) {
        ws.send('welcome');
      },
      message(ws, message) {
        if (message === 'close-4000') {
          ws.close(4000, 'app closed');
          return;
        }
        if (message === 'big') {
          ws.send('x'.repeat(2 * 1024 * 1024));
          return;
        }
        ws.send(typeof message === 'string' ? `echo:${message}` : message);
      },
      close(_ws, code) {
        upstreamCloses.push(code);
      },
    },
  });
  refusedServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('kilo') });
  const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  closedPort = portOf(closed);
  void closed.stop(true);
});

afterAll(async () => {
  // Bun 1.3 does not settle a forced stop after the server closed a WebSocket.
  void devServer.stop(true);
  await refusedServer.stop(true);
});

afterEach(async () => {
  releaseHead.resolve();
  client?.stop();
  await worker?.stop();
  client = undefined;
  worker = undefined;
  releaseHead = Promise.withResolvers<void>();
  abortedRequests = 0;
  devRequests = [];
  upstreamCloses = [];
});

function startClient(limits?: Partial<PreviewTunnelLimits>): {
  worker: FakeTunnelWorker;
  client: PreviewTunnelClient;
} {
  worker = startFakeTunnelWorker();
  client = createPreviewTunnelClient({
    url: worker.url,
    credential: 'launch-jwt',
    forwarder: createPreviewForwarder({
      refusedPorts: () => [portOf(refusedServer)],
      headTimeoutMs: 5_000,
      socketTimeoutMs: 2_000,
    }),
    log: () => undefined,
    ...(limits === undefined ? {} : { limits }),
  });
  return { worker, client };
}

async function connected(limits?: Partial<PreviewTunnelLimits>) {
  const started = startClient(limits);
  started.client.demand();
  await started.worker.waitForConnection();
  return started;
}

function open(stream: number, path: string, method = 'GET', port = portOf(devServer)) {
  return {
    type: 'open',
    stream,
    open: { port, method, path, headers: [['accept', 'text/plain']] },
  } satisfies PreviewTunnelFrame;
}

function wsOpen(stream: number, protocols: string[] = []) {
  return {
    type: 'ws_open',
    stream,
    open: { port: portOf(devServer), path: '/hmr', headers: [], protocols },
  } satisfies PreviewTunnelFrame;
}

/** Reads a response body to the end; with `grant`, returns credit for each frame. */
async function readBody(
  tunnel: FakeTunnelWorker,
  stream: number,
  grant = true
): Promise<{ bytes: Uint8Array; maxOutstanding: number }> {
  const chunks: Uint8Array[] = [];
  let outstanding = 0;
  let maxOutstanding = 0;
  for (;;) {
    const frame = await tunnel.next(stream, 5_000);
    if (frame.type === 'end') break;
    // The open acknowledgement or request-body credit.
    if (frame.type === 'credit') continue;
    if (frame.type !== 'data') throw new Error(`Unexpected ${frame.type} in the body`);
    chunks.push(frame.bytes.slice());
    outstanding += frame.bytes.byteLength;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    if (grant) {
      tunnel.send({ type: 'credit', stream, bytes: frame.bytes.byteLength });
      outstanding -= frame.bytes.byteLength;
    }
  }
  return { bytes: Buffer.concat(chunks), maxOutstanding };
}

describe('preview tunnel client: HTTP streams', () => {
  it('connects with the launch credential and acknowledges an open before the dev server answers', async () => {
    const { worker } = await connected();
    expect(worker.authorizations).toEqual(['Bearer launch-jwt']);
    worker.send(open(1, '/slow-head'));
    expect(await worker.next(1)).toEqual({ type: 'credit', stream: 1, bytes: 0 });
    await until(() => devRequests.includes('/slow-head'));
    await Bun.sleep(50);
    expect(worker.pending()).toEqual([]);
    releaseHead.resolve();
    expect(await worker.next(1)).toMatchObject({ type: 'head', head: { status: 200 } });
    expect(decoder.decode((await readBody(worker, 1)).bytes)).toBe('late');
  });

  it('acknowledges, then resets a port with no listener and a refused port', async () => {
    const { worker } = await connected();
    worker.send(open(1, '/', 'GET', closedPort));
    expect(await worker.next(1)).toMatchObject({ type: 'credit', bytes: 0 });
    expect(await worker.next(1)).toMatchObject({ type: 'reset', code: 'not_listening' });
    worker.send(open(3, '/', 'GET', portOf(refusedServer)));
    expect(await worker.next(3)).toMatchObject({ type: 'credit', bytes: 0 });
    expect(await worker.next(3)).toMatchObject({ type: 'reset', code: 'reserved' });
  });

  it('relays the head with each cookie and without preview markers', async () => {
    const { worker } = await connected();
    worker.send(open(1, '/hello'));
    await worker.take('credit', 1);
    const head = await worker.take('head', 1);
    expect(head.head.status).toBe(200);
    expect(head.head.headers.filter(([name]) => name === 'set-cookie')).toEqual([
      ['set-cookie', 'a=1; Path=/'],
      ['set-cookie', 'b=2; Path=/'],
    ]);
    expect(head.head.headers.some(([name]) => name.startsWith('x-kilo-preview-'))).toBe(false);
    expect(decoder.decode((await readBody(worker, 1)).bytes)).toBe('hello');
  });

  it('sends the end at once after a head without a body', async () => {
    const { worker } = await connected();
    worker.send(open(1, '/hello', 'HEAD'));
    expect((await worker.next(1)).type).toBe('credit');
    expect(await worker.next(1)).toMatchObject({ type: 'head', head: { status: 200 } });
    expect((await worker.next(1)).type).toBe('end');
    worker.send(open(3, '/empty'));
    expect((await worker.next(3)).type).toBe('credit');
    expect(await worker.next(3)).toMatchObject({ type: 'head', head: { status: 204 } });
    expect((await worker.next(3)).type).toBe('end');
  });

  it('sends a 64 MiB body within the credit', async () => {
    const { worker } = await connected();
    worker.send(open(1, '/big'));
    await worker.take('head', 1);
    const { bytes, maxOutstanding } = await readBody(worker, 1);
    expect(bytes.byteLength).toBe(BIG_BYTES);
    expect(sha(bytes)).toBe(BIG_SHA);
    expect(maxOutstanding).toBeLessThanOrEqual(PREVIEW_TUNNEL_WINDOW_BYTES);
  });

  it('stops at one window for a reader that grants no credit, and a reset ends the stream', async () => {
    const { worker } = await connected();
    worker.send(open(1, '/big'));
    await worker.take('head', 1);
    let received = 0;
    for (;;) {
      const data = await worker.take('data', 1, 300).catch(() => null);
      if (data === null) break;
      received += data.bytes.byteLength;
    }
    // The sender waits for credit for a whole data frame, so it stops within one frame of the window.
    expect(received).toBeLessThanOrEqual(PREVIEW_TUNNEL_WINDOW_BYTES);
    expect(received).toBeGreaterThan(PREVIEW_TUNNEL_WINDOW_BYTES - PREVIEW_TUNNEL_DATA_MAX_BYTES);
    worker.send({ type: 'reset', stream: 1, code: 'cancelled' });
    worker.send(open(3, '/hello'));
    await worker.take('head', 3);
    expect(decoder.decode((await readBody(worker, 3)).bytes)).toBe('hello');
  });

  it('uploads a 16 MiB body within the wrapper credit', async () => {
    const { worker } = await connected();
    const upload = pattern(UPLOAD_BYTES);
    worker.send(open(1, '/upload', 'POST'));
    let credit = PREVIEW_TUNNEL_WINDOW_BYTES;
    for (let sent = 0; sent < UPLOAD_BYTES; sent += PREVIEW_TUNNEL_DATA_MAX_BYTES) {
      while (credit < PREVIEW_TUNNEL_DATA_MAX_BYTES) {
        credit += (await worker.take('credit', 1, 5_000)).bytes;
      }
      const chunk = upload.subarray(sent, sent + PREVIEW_TUNNEL_DATA_MAX_BYTES);
      worker.send({ type: 'data', stream: 1, bytes: chunk });
      credit -= chunk.byteLength;
    }
    worker.send({ type: 'end', stream: 1 });
    expect(await worker.take('head', 1, 5_000)).toMatchObject({ head: { status: 200 } });
    const reply = JSON.parse(decoder.decode((await readBody(worker, 1)).bytes));
    expect(reply).toEqual({ bytes: UPLOAD_BYTES, sha: sha(upload) });
  });

  it('closes the tunnel on request data over the credit', async () => {
    const { worker } = await connected();
    // A GET body is never read, so the wrapper returns no credit.
    worker.send(open(1, '/slow-head'));
    await worker.take('credit', 1);
    const chunk = new Uint8Array(PREVIEW_TUNNEL_DATA_MAX_BYTES);
    for (let sent = 0; sent < PREVIEW_TUNNEL_WINDOW_BYTES; sent += chunk.byteLength) {
      worker.send({ type: 'data', stream: 1, bytes: chunk });
    }
    worker.send({ type: 'data', stream: 1, bytes: new Uint8Array(1) });
    expect(await worker.waitForClose()).toBe(1008);
  });

  it('cancels the dev server request when the Worker resets the stream', async () => {
    const { worker } = await connected();
    worker.send(open(1, '/hang-body'));
    await worker.take('head', 1);
    expect(decoder.decode((await worker.take('data', 1)).bytes)).toBe('first');
    worker.send({ type: 'reset', stream: 1, code: 'cancelled' });
    await until(() => abortedRequests === 1);
  });

  it('answers busy over the stream cap without an acknowledgement', async () => {
    const { worker } = await connected({ maxHttpStreams: 1 });
    worker.send(open(1, '/slow-head'));
    await worker.take('credit', 1);
    worker.send(open(3, '/hello'));
    expect(await worker.next(3)).toEqual({ type: 'reset', stream: 3, code: 'busy' });
    releaseHead.resolve();
    await worker.take('head', 1);
    await readBody(worker, 1);
    worker.send(open(5, '/hello'));
    expect((await worker.next(5)).type).toBe('credit');
  });
});

describe('preview tunnel client: WebSocket streams', () => {
  const wsId = PREVIEW_TUNNEL_WS_ID_BASE + 1;

  it('relays a WebSocket with its subprotocol and close codes', async () => {
    const { worker } = await connected();
    worker.send(wsOpen(wsId, ['vite-hmr', 'other']));
    expect(await worker.next(wsId)).toMatchObject({ type: 'credit', bytes: 0 });
    expect(await worker.next(wsId)).toEqual({
      type: 'ws_accept',
      stream: wsId,
      protocol: 'vite-hmr',
    });
    expect(await worker.next(wsId)).toMatchObject({ type: 'ws_text', text: 'welcome' });
    worker.send({ type: 'ws_text', stream: wsId, text: 'hi' });
    expect(await worker.next(wsId)).toMatchObject({ type: 'ws_text', text: 'echo:hi' });
    worker.send({ type: 'ws_binary', stream: wsId, bytes: new Uint8Array([1, 2, 3]) });
    const binary = await worker.next(wsId);
    expect(binary.type === 'ws_binary' ? [...binary.bytes] : []).toEqual([1, 2, 3]);
    worker.send({ type: 'ws_text', stream: wsId, text: 'close-4000' });
    expect(await worker.next(wsId)).toEqual({
      type: 'ws_close',
      stream: wsId,
      code: 4000,
      reason: 'app closed',
    });

    worker.send(wsOpen(wsId + 1));
    await worker.take('ws_accept', wsId + 1);
    worker.send({ type: 'ws_close', stream: wsId + 1, code: 4001, reason: 'browser left' });
    await until(() => upstreamCloses.includes(4001));
  });

  it('closes a stream whose dev server message is over 1 MiB', async () => {
    const { worker } = await connected();
    worker.send(wsOpen(wsId));
    await worker.take('ws_text', wsId);
    worker.send({ type: 'ws_text', stream: wsId, text: 'big' });
    expect(await worker.take('ws_close', wsId)).toMatchObject({ code: 1009 });
    await until(() => upstreamCloses.includes(1009));
    expect(worker.closeCode()).toBeNull();
  });

  it('resets a WebSocket for a port with no listener', async () => {
    const { worker } = await connected();
    worker.send({ ...wsOpen(wsId), open: { ...wsOpen(wsId).open, port: closedPort } });
    expect((await worker.next(wsId)).type).toBe('credit');
    expect(await worker.next(wsId)).toMatchObject({ type: 'reset', code: 'not_listening' });
  });
});

describe('preview tunnel client: tunnel lifecycle', () => {
  it('closes the tunnel on a text message or an unknown frame type', async () => {
    const first = await connected();
    first.worker.sendRaw('{"type":"open"}');
    expect(await first.worker.waitForClose()).toBe(1003);
    first.client.demand();
    await first.worker.waitForConnection(2);
    first.worker.sendRaw(new Uint8Array([99, 0, 0, 0, 1]));
    expect(await first.worker.waitForClose(1)).toBe(1008);
  });

  it('closes after the idle time only when no stream is open', async () => {
    const { worker } = await connected({ idleCloseMs: 150 });
    worker.send(open(1, '/slow-head'));
    await worker.take('credit', 1);
    await Bun.sleep(300);
    expect(worker.closeCode()).toBeNull();
    releaseHead.resolve();
    await worker.take('head', 1);
    await readBody(worker, 1);
    expect(await worker.waitForClose(0, 1_000)).toBe(1000);
  });

  it('opens a new tunnel on each demand and fails the streams of the old one', async () => {
    const { worker, client } = await connected();
    worker.send(open(1, '/hang-body'));
    await worker.take('data', 1);
    client.demand();
    await worker.waitForConnection(2);
    expect(await worker.waitForClose(0)).toBe(1000);
    await until(() => abortedRequests === 1);
    worker.send(open(1, '/hello'));
    await worker.take('head', 1);
    expect(decoder.decode((await readBody(worker, 1)).bytes)).toBe('hello');
  });

  it('cancels the dev server request when the tunnel drops in the middle of a body', async () => {
    const { worker, client } = await connected();
    worker.send(open(1, '/hang-body'));
    await worker.take('data', 1);
    expect(client.openStreams()).toBe(1);
    worker.close(1001);
    await until(() => abortedRequests === 1);
    await until(() => client.openStreams() === null);
  });

  it('sends protocol pings while the tunnel is open', async () => {
    const { worker } = await connected({ pingIntervalMs: 40 });
    await until(() => worker.pings() >= 3);
    expect(worker.closeCode()).toBeNull();
  });

  it('does nothing on a demand without a tunnel URL', () => {
    const logs: string[] = [];
    let connects = 0;
    const local = createPreviewTunnelClient({
      url: null,
      credential: 'launch-jwt',
      forwarder: createPreviewForwarder({
        refusedPorts: () => [],
        headTimeoutMs: 1,
        socketTimeoutMs: 1,
      }),
      log: message => logs.push(message),
      connect: () => {
        connects += 1;
        throw new Error('unexpected connect');
      },
    });
    local.demand();
    expect(connects).toBe(0);
    expect(logs).toHaveLength(1);
    expect(local.openStreams()).toBeNull();
  });
});

/** A socket that answers pings only when told to. */
class FakeSocket extends EventTarget {
  binaryType = 'blob';
  pings = 0;
  closeCode: number | null = null;

  constructor(private readonly answerPings: boolean) {
    super();
  }

  send(): void {}

  ping(): void {
    this.pings += 1;
    if (this.answerPings) queueMicrotask(() => this.dispatchEvent(new Event('pong')));
  }

  close(code: number): void {
    this.closeCode = code;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
}

describe('preview tunnel client: missed pongs', () => {
  function fakeClient(socket: FakeSocket): PreviewTunnelClient {
    return createPreviewTunnelClient({
      url: 'ws://tunnel.test/sandbox-preview-tunnel/sbx_1',
      credential: 'launch-jwt',
      forwarder: createPreviewForwarder({
        refusedPorts: () => [],
        headTimeoutMs: 1,
        socketTimeoutMs: 1,
      }),
      log: () => undefined,
      limits: { pingIntervalMs: 20, missedPongLimit: 2 },
      connect: () => socket as unknown as TunnelSocket,
    });
  }

  it('closes the tunnel after two pings without a pong', async () => {
    const socket = new FakeSocket(false);
    const local = fakeClient(socket);
    local.demand();
    socket.dispatchEvent(new Event('open'));
    await until(() => socket.closeCode !== null, 1_000);
    expect(socket.pings).toBe(2);
    expect(socket.closeCode).toBe(1001);
    expect(local.openStreams()).toBeNull();
  });

  it('keeps the tunnel while pongs come', async () => {
    const socket = new FakeSocket(true);
    const local = fakeClient(socket);
    local.demand();
    socket.dispatchEvent(new Event('open'));
    await until(() => socket.pings >= 5, 1_000);
    expect(socket.closeCode).toBeNull();
    local.stop();
    expect(socket.closeCode).toBe(1001);
  });
});
