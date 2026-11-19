import { evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_UPSTREAM_TIMEOUT_TEXT,
  PREVIEW_UNAVAILABLE_TEXT,
} from '../../src/preview/container-port-fetch.js';
import {
  PREVIEW_BAD_RESPONSE_TEXT,
  PREVIEW_TOO_MANY_STREAMS_TEXT,
  PREVIEW_UNSUPPORTED_REQUEST_TEXT,
} from '../../src/preview-tunnel/failures.js';
import { PREVIEW_TUNNEL_LIMITS } from '../../src/preview-tunnel/preview-tunnel-do.js';
import {
  PREVIEW_TUNNEL_WS_ID_BASE,
  PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES,
} from '../../src/shared/preview-tunnel-protocol.js';
import {
  connectTunnelPeer,
  newTunnelIdentity,
  previewRequest,
  previewTunnelStub,
  setTunnelLimits,
  type PreviewTunnelStub,
  type TunnelPeer,
} from './helpers/preview-tunnel-peer.js';
import { waitFor } from './wait-for.js';

afterEach(async () => {
  await reset();
});

type BrowserSocket = {
  socket: WebSocket;
  stream: number;
  protocol: string | null;
  messages: Array<string | ArrayBuffer>;
  closed: () => { code: number; reason: string } | null;
};

async function connectedTunnel() {
  const { sandboxId, allocationId } = newTunnelIdentity();
  const stub = previewTunnelStub(sandboxId, allocationId);
  const peer = await connectTunnelPeer(stub, allocationId);
  return { stub, peer, allocationId };
}

function upgradeRequest(allocationId: string, protocols?: string): Request {
  return previewRequest('/hmr', {
    allocationId,
    headers: {
      Upgrade: 'websocket',
      ...(protocols === undefined ? {} : { 'Sec-WebSocket-Protocol': protocols }),
    },
  });
}

/** Opens a browser WebSocket through the tunnel; the peer accepts with `protocol`. */
async function openBrowserSocket(
  stub: PreviewTunnelStub,
  peer: TunnelPeer,
  allocationId: string,
  protocol = ''
): Promise<BrowserSocket> {
  const pending = stub.fetch(upgradeRequest(allocationId, protocol || undefined));
  const open = await peer.takeType('ws_open');
  peer.send({ type: 'ws_accept', stream: open.stream, protocol });
  const response = await pending;
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('The browser upgrade returned no socket');
  const messages: Array<string | ArrayBuffer> = [];
  let closed: { code: number; reason: string } | null = null;
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => {
    messages.push(event.data as string | ArrayBuffer);
  });
  socket.addEventListener('close', event => {
    closed = { code: event.code, reason: event.reason };
  });
  socket.accept();
  return {
    socket,
    stream: open.stream,
    protocol: response.headers.get('Sec-WebSocket-Protocol'),
    messages,
    closed: () => closed,
  };
}

async function expectFailure(response: Response, status: number, text: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(text);
}

describe('PreviewTunnel WebSocket streams', () => {
  it('relays messages both ways, also after the Durable Object hibernates', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(upgradeRequest(allocationId, 'vite-hmr, other'));
    const open = await peer.takeType('ws_open');
    expect(open.stream).toBeGreaterThanOrEqual(PREVIEW_TUNNEL_WS_ID_BASE);
    expect(open.open).toMatchObject({ port: 3000, path: '/hmr', protocols: ['vite-hmr', 'other'] });
    const names = open.open.headers.map(([name]) => name.toLowerCase());
    expect(names.filter(name => name.startsWith('sec-websocket-') || name === 'upgrade')).toEqual(
      []
    );
    peer.send({ type: 'ws_accept', stream: open.stream, protocol: 'vite-hmr' });
    const response = await pending;
    expect(response.status).toBe(101);
    expect(response.headers.get('Sec-WebSocket-Protocol')).toBe('vite-hmr');
    const socket = response.webSocket!;
    const messages: Array<string | ArrayBuffer> = [];
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', event => {
      messages.push(event.data as string | ArrayBuffer);
    });
    socket.accept();
    const stream = open.stream;

    socket.send('ping');
    expect(await peer.takeType('ws_text', stream)).toMatchObject({ text: 'ping' });
    socket.send(new Uint8Array([1, 2, 3]));
    expect((await peer.takeType('ws_binary', stream)).bytes).toEqual(new Uint8Array([1, 2, 3]));
    peer.send({ type: 'ws_text', stream, text: 'pong' });
    peer.send({ type: 'ws_binary', stream, bytes: new Uint8Array([9]) });
    await waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toBe('pong');
    expect(new Uint8Array(messages[1] as ArrayBuffer)).toEqual(new Uint8Array([9]));

    // A real eviction: both sockets hibernate and the next message wakes the DO.
    await evictDurableObject(stub);
    socket.send('after-wake');
    expect(await peer.takeType('ws_text', stream)).toMatchObject({ text: 'after-wake' });
    peer.send({ type: 'ws_text', stream, text: 'back' });
    await waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toBe('back');

    // The woken DO still serves HTTP on the same tunnel.
    const http = stub.fetch(previewRequest('/after-wake', { allocationId }));
    const httpOpen = await peer.takeType('open');
    peer.respond(httpOpen.stream, 200, 'awake');
    expect(await (await http).text()).toBe('awake');
  });

  it('sends the browser close to the wrapper and frees the slot', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    await setTunnelLimits(stub, { webSocket: { capacity: 1, maxWaiters: 0, waitMs: 1_000 } });
    const first = await openBrowserSocket(stub, peer, allocationId);
    await expectFailure(
      await stub.fetch(upgradeRequest(allocationId)),
      503,
      PREVIEW_TOO_MANY_STREAMS_TEXT
    );
    first.socket.close(1000, 'done');
    expect(await peer.takeType('ws_close', first.stream)).toMatchObject({
      code: 1000,
      reason: 'done',
    });
    const second = await openBrowserSocket(stub, peer, allocationId);
    expect(second.stream).not.toBe(first.stream);
  });

  it('counts a hibernated browser socket against the slots after a wake', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const limits = { webSocket: { capacity: 1, maxWaiters: 0, waitMs: 1_000 } };
    await setTunnelLimits(stub, limits);
    const first = await openBrowserSocket(stub, peer, allocationId);

    await evictDurableObject(stub);
    await setTunnelLimits(stub, limits);
    await expectFailure(
      await stub.fetch(upgradeRequest(allocationId)),
      503,
      PREVIEW_TOO_MANY_STREAMS_TEXT
    );

    first.socket.close(1000, 'done');
    expect(await peer.takeType('ws_close', first.stream)).toMatchObject({ code: 1000 });
    const third = await openBrowserSocket(stub, peer, allocationId);
    expect(third.stream).not.toBe(first.stream);
  });

  it('closes the browser socket when the wrapper closes the stream', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const browser = await openBrowserSocket(stub, peer, allocationId);
    peer.send({ type: 'ws_close', stream: browser.stream, code: 4000, reason: 'server gone' });
    await waitFor(() => expect(browser.closed()).toMatchObject({ code: 4000 }));
    // A late message for the closed stream is dropped, not a violation.
    peer.send({ type: 'ws_text', stream: browser.stream, text: 'late' });
    const again = await openBrowserSocket(stub, peer, allocationId);
    expect(peer.closeInfo()).toBeNull();
    again.socket.close();
  });

  it('closes a browser message over 1 MiB with 1009 and keeps the tunnel', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const browser = await openBrowserSocket(stub, peer, allocationId);
    browser.socket.send(new Uint8Array(PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES + 1));
    expect(await peer.takeType('ws_close', browser.stream)).toMatchObject({ code: 1009 });
    await waitFor(() => expect(browser.closed()).toMatchObject({ code: 1009 }));
    expect(peer.pending().filter(frame => frame.type === 'ws_binary')).toEqual([]);
    const next = await openBrowserSocket(stub, peer, allocationId);
    expect(peer.closeInfo()).toBeNull();
    next.socket.close();
  });

  it('closes the browser sockets of a tunnel that ends', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const browser = await openBrowserSocket(stub, peer, allocationId);
    peer.sendRaw('not binary');
    expect(await peer.waitForClose()).toMatchObject({ code: 1003 });
    await waitFor(() => expect(browser.closed()).toMatchObject({ code: 1011 }));
  });

  it('refuses a protocol the browser did not offer', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(upgradeRequest(allocationId, 'vite-hmr'));
    const open = await peer.takeType('ws_open');
    peer.send({ type: 'ws_accept', stream: open.stream, protocol: 'other' });
    await expectFailure(await pending, 502, PREVIEW_BAD_RESPONSE_TEXT);
    expect(await peer.takeType('reset', open.stream)).toMatchObject({ code: 'cancelled' });
    expect(peer.closeInfo()).toBeNull();
  });

  it('refuses more protocols than the wrapper accepts without a tunnel frame', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const protocols = Array.from({ length: 33 }, (_, index) => `p${index}`).join(', ');
    await expectFailure(
      await stub.fetch(upgradeRequest(allocationId, protocols)),
      400,
      PREVIEW_UNSUPPORTED_REQUEST_TEXT
    );
    expect(peer.opens).toBe(0);
  });

  it('answers 504 when the wrapper does not accept before the backstop', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    await setTunnelLimits(stub, { acceptBackstopMs: 200 });
    const pending = stub.fetch(upgradeRequest(allocationId));
    const open = await peer.takeType('ws_open');
    await expectFailure(await pending, 504, PREVIEW_UPSTREAM_TIMEOUT_TEXT);
    expect(await peer.takeType('reset', open.stream)).toMatchObject({ code: 'cancelled' });
    expect(peer.closeInfo()).toBeNull();
  });

  it('fails an upgrade whose tunnel closes before the accept', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    expect(PREVIEW_TUNNEL_LIMITS.acceptBackstopMs).toBeGreaterThan(1_000);
    const pending = stub.fetch(upgradeRequest(allocationId));
    await peer.takeType('ws_open');
    peer.close(1000, 'wrapper stops');
    await expectFailure(await pending, 503, PREVIEW_UNAVAILABLE_TEXT);
  });
});
