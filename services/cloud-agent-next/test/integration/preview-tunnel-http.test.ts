import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PREVIEW_NOT_LISTENING_TEXT,
  PREVIEW_NOT_RUNNING_TEXT,
  PREVIEW_RESERVED_PORT_TEXT,
  PREVIEW_UNAVAILABLE_TEXT,
  PREVIEW_UPSTREAM_TIMEOUT_TEXT,
} from '../../src/preview/container-port-fetch.js';
import {
  PREVIEW_BAD_RESPONSE_TEXT,
  PREVIEW_REQUEST_TOO_LARGE_TEXT,
  PREVIEW_TOO_MANY_STREAMS_TEXT,
} from '../../src/preview-tunnel/failures.js';
import {
  PREVIEW_TUNNEL_LIMITS,
  type PreviewTunnel,
} from '../../src/preview-tunnel/preview-tunnel-do.js';
import { PREVIEW_TUNNEL_CONNECT_HEADER } from '../../src/shared/preview-headers.js';
import {
  encodePreviewTunnelFrame,
  PREVIEW_TUNNEL_DATA_MAX_BYTES,
  PREVIEW_TUNNEL_MAX_HTTP_STREAMS,
  PREVIEW_TUNNEL_WINDOW_BYTES,
  PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES,
  type PreviewTunnelFrame,
} from '../../src/shared/preview-tunnel-protocol.js';
import {
  connectTunnelPeer,
  newTunnelIdentity,
  previewRequest,
  previewTunnelStub,
  rawTunnelFrame,
  setTunnelLimits,
  type PreviewTunnelStub,
  type TunnelPeer,
} from './helpers/preview-tunnel-peer.js';
import { waitFor } from './wait-for.js';

afterEach(async () => {
  await reset();
});

const encoder = new TextEncoder();

async function connectedTunnel(): Promise<{
  stub: PreviewTunnelStub;
  peer: TunnelPeer;
  allocationId: string;
}> {
  const { sandboxId, allocationId } = newTunnelIdentity();
  const stub = previewTunnelStub(sandboxId, allocationId);
  const peer = await connectTunnelPeer(stub, allocationId);
  return { stub, peer, allocationId };
}

/** One GET through the tunnel, answered by the peer; proves the tunnel still works. */
async function roundTrip(stub: PreviewTunnelStub, peer: TunnelPeer, allocationId: string) {
  const pending = stub.fetch(previewRequest('/still-open', { allocationId }));
  const open = await peer.takeType('open');
  expect(open.open.path).toBe('/still-open');
  peer.respond(open.stream, 200, 'ok');
  const response = await pending;
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('ok');
}

async function expectFailure(response: Response, status: number, text: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(text);
}

describe('PreviewTunnel connect', () => {
  it('refuses a connect for another allocation, without an upgrade, or without a marker', async () => {
    const { sandboxId, allocationId } = newTunnelIdentity();
    const stub = previewTunnelStub(sandboxId, allocationId);
    const other = await stub.fetch('https://tunnel.test/', {
      headers: { Upgrade: 'websocket', [PREVIEW_TUNNEL_CONNECT_HEADER]: 'alloc_other' },
    });
    expect(other.status).toBe(403);
    const plain = await stub.fetch('https://tunnel.test/', {
      headers: { [PREVIEW_TUNNEL_CONNECT_HEADER]: allocationId },
    });
    expect(plain.status).toBe(426);
    const bare = await stub.fetch('https://tunnel.test/', { headers: { Upgrade: 'websocket' } });
    expect(bare.status).toBe(404);
  });

  it('proxies a request that has the port marker even when it also has the connect header', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(
      previewRequest('/socket', {
        allocationId,
        headers: { Upgrade: 'websocket', [PREVIEW_TUNNEL_CONNECT_HEADER]: allocationId },
      })
    );
    const open = await peer.takeType('ws_open');
    expect(open.open.headers.map(([name]) => name.toLowerCase())).not.toContain(
      PREVIEW_TUNNEL_CONNECT_HEADER
    );
    peer.send({ type: 'reset', stream: open.stream, code: 'not_listening' });
    await expectFailure(await pending, 502, PREVIEW_NOT_LISTENING_TEXT);
    expect(peer.closeInfo()).toBeNull();
    await roundTrip(stub, peer, allocationId);
  });

  it('replaces the old tunnel with 4001 and fails its open streams', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(previewRequest('/slow', { allocationId }));
    await peer.takeType('open');
    const next = await connectTunnelPeer(stub, allocationId);
    expect(await peer.waitForClose()).toMatchObject({ code: 4001 });
    await expectFailure(await pending, 503, PREVIEW_UNAVAILABLE_TEXT);
    await roundTrip(stub, next, allocationId);
  });
});

describe('PreviewTunnel HTTP streams', () => {
  it('relays the request body and a streamed response without preview markers', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(
      previewRequest('/api/items?x=1', {
        allocationId,
        port: '5173',
        method: 'POST',
        body: 'hello',
        headers: { 'content-type': 'text/plain', 'x-kilo-preview-forged': 'yes' },
      })
    );
    const open = await peer.takeType('open');
    expect(open.open).toMatchObject({ port: 5173, method: 'POST', path: '/api/items?x=1' });
    const names = open.open.headers.map(([name]) => name.toLowerCase());
    expect(names).toContain('content-type');
    expect(names.filter(name => name.startsWith('x-kilo-preview-') || name === 'host')).toEqual([]);
    const data = await peer.takeType('data', open.stream);
    expect(new TextDecoder().decode(data.bytes)).toBe('hello');
    await peer.takeType('end', open.stream);

    peer.send({
      type: 'head',
      stream: open.stream,
      head: { status: 201, headers: [['x-upstream', '1']] },
    });
    peer.send({ type: 'data', stream: open.stream, bytes: encoder.encode('wor') });
    peer.send({ type: 'data', stream: open.stream, bytes: encoder.encode('ld') });
    peer.send({ type: 'end', stream: open.stream });
    const response = await pending;
    expect(response.status).toBe(201);
    expect(response.headers.get('x-upstream')).toBe('1');
    expect(await response.text()).toBe('world');

    // A late frame for an ended stream is dropped, not a violation.
    peer.send({ type: 'credit', stream: open.stream, bytes: 0 });
    await roundTrip(stub, peer, allocationId);
  });

  it.each([
    { method: 'HEAD', status: 200 },
    { method: 'GET', status: 204 },
    { method: 'GET', status: 304 },
  ])('answers $method $status without a body', async ({ method, status }) => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(previewRequest('/', { allocationId, method }));
    const open = await peer.takeType('open');
    peer.send({ type: 'head', stream: open.stream, head: { status, headers: [] } });
    const response = await pending;
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    peer.send({ type: 'end', stream: open.stream });
    await roundTrip(stub, peer, allocationId);
  });

  it('fails only the stream when the response has a header a Worker cannot send', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(previewRequest('/', { allocationId }));
    const open = await peer.takeType('open');
    peer.send({
      type: 'head',
      stream: open.stream,
      head: { status: 200, headers: [['bad header', 'x']] },
    });
    await expectFailure(await pending, 502, PREVIEW_BAD_RESPONSE_TEXT);
    expect(await peer.takeType('reset', open.stream)).toMatchObject({ code: 'bad_response' });
    await roundTrip(stub, peer, allocationId);
  });

  it.each([
    { code: 'not_listening', status: 502, text: PREVIEW_NOT_LISTENING_TEXT, retry: null },
    { code: 'timeout', status: 504, text: PREVIEW_UPSTREAM_TIMEOUT_TEXT, retry: null },
    { code: 'reserved', status: 403, text: PREVIEW_RESERVED_PORT_TEXT, retry: null },
    { code: 'busy', status: 503, text: PREVIEW_TOO_MANY_STREAMS_TEXT, retry: '1' },
    { code: 'protocol', status: 503, text: PREVIEW_UNAVAILABLE_TEXT, retry: '1' },
  ] as const)('maps a wrapper reset $code to $status', async ({ code, status, text, retry }) => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(previewRequest('/', { allocationId }));
    const open = await peer.takeType('open');
    peer.send({ type: 'reset', stream: open.stream, code });
    const response = await pending;
    expect(response.headers.get('Retry-After')).toBe(retry);
    await expectFailure(response, status, text);
    await roundTrip(stub, peer, allocationId);
  });

  it('refuses a request for another allocation or a bad port without a tunnel frame', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const stale = previewRequest('/', { allocationId: 'alloc_previous' });
    await expectFailure(await stub.fetch(stale), 503, PREVIEW_NOT_RUNNING_TEXT);
    for (const port of ['80', '65536', '3000x']) {
      await expectFailure(
        await stub.fetch(previewRequest('/', { allocationId, port })),
        403,
        PREVIEW_RESERVED_PORT_TEXT
      );
    }
    expect(peer.opens).toBe(0);
  });

  it('refuses a request that the wrapper could not decode, and the tunnel stays open', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const large = previewRequest('/', {
      allocationId,
      headers: { 'x-large': 'a'.repeat(70 * 1024) },
    });
    await expectFailure(await stub.fetch(large), 431, PREVIEW_REQUEST_TOO_LARGE_TEXT);
    expect(peer.opens).toBe(0);
    await roundTrip(stub, peer, allocationId);
  });

  it('resets the stream when the browser cancels the body', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    const pending = stub.fetch(previewRequest('/stream', { allocationId }));
    const open = await peer.takeType('open');
    peer.send({ type: 'head', stream: open.stream, head: { status: 200, headers: [] } });
    peer.send({ type: 'data', stream: open.stream, bytes: encoder.encode('part') });
    const response = await pending;
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(await peer.takeType('reset', open.stream)).toMatchObject({ code: 'cancelled' });
    await roundTrip(stub, peer, allocationId);
  });

  it('answers 504 when the wrapper sends no head before the backstop', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    await setTunnelLimits(stub, { headBackstopMs: 200 });
    const pending = stub.fetch(previewRequest('/', { allocationId }));
    const open = await peer.takeType('open');
    await expectFailure(await pending, 504, PREVIEW_UPSTREAM_TIMEOUT_TEXT);
    expect(await peer.takeType('reset', open.stream)).toMatchObject({ code: 'cancelled' });
    await roundTrip(stub, peer, allocationId);
  });
});

describe('PreviewTunnel violations', () => {
  async function pendingStream() {
    const tunnel = await connectedTunnel();
    const response = tunnel.stub.fetch(previewRequest('/', { allocationId: tunnel.allocationId }));
    const open = await tunnel.peer.takeType('open');
    return { ...tunnel, response, stream: open.stream };
  }

  it.each([
    {
      name: 'a frame for a stream the Durable Object did not open',
      code: 1008,
      frame: (_stream: number) => rawTunnelFrame(6, 77, new Uint8Array(4)),
    },
    {
      name: 'credit over the window',
      code: 1008,
      frame: (stream: number) => rawTunnelFrame(6, stream, new Uint8Array([0, 0, 0, 1])),
    },
    {
      name: 'an unknown frame type',
      code: 1008,
      frame: (stream: number) => rawTunnelFrame(99, stream, new Uint8Array(0)),
    },
    {
      name: 'a frame type only the Worker sends',
      code: 1008,
      frame: (stream: number) => rawTunnelFrame(1, stream, encoder.encode('{}')),
    },
    {
      name: 'stream id zero',
      code: 1008,
      frame: (_stream: number) => rawTunnelFrame(4, 0, new Uint8Array(0)),
    },
    {
      name: 'data before the head',
      code: 1008,
      frame: (stream: number) => rawTunnelFrame(3, stream, encoder.encode('x')),
    },
    {
      name: 'a data frame over 64 KiB',
      code: 1008,
      frame: (stream: number) =>
        rawTunnelFrame(3, stream, new Uint8Array(PREVIEW_TUNNEL_DATA_MAX_BYTES + 1)),
    },
    {
      name: 'a WebSocket message over 1 MiB',
      code: 1009,
      frame: (stream: number) =>
        rawTunnelFrame(10, stream, new Uint8Array(PREVIEW_TUNNEL_WS_MESSAGE_MAX_BYTES + 1)),
    },
    {
      name: 'a JSON payload over 64 KiB',
      code: 1008,
      frame: (stream: number) => rawTunnelFrame(2, stream, new Uint8Array(64 * 1024 + 1)),
    },
  ])('closes the tunnel on $name', async ({ code, frame }) => {
    const { stub, peer, response, stream, allocationId } = await pendingStream();
    peer.sendRaw(frame(stream));
    expect(await peer.waitForClose()).toMatchObject({ code });
    await expectFailure(await response, 503, PREVIEW_UNAVAILABLE_TEXT);
    const replacement = await connectTunnelPeer(stub, allocationId);
    await roundTrip(stub, replacement, allocationId);
  });

  it('closes the tunnel with 1003 on a text message', async () => {
    const { peer, response } = await pendingStream();
    peer.sendRaw('{"type":"head"}');
    expect(await peer.waitForClose()).toMatchObject({ code: 1003 });
    await expectFailure(await response, 503, PREVIEW_UNAVAILABLE_TEXT);
  });

  it('closes the tunnel on a repeated head', async () => {
    const { peer, response, stream } = await pendingStream();
    const head: PreviewTunnelFrame = { type: 'head', stream, head: { status: 200, headers: [] } };
    peer.send(head);
    expect((await response).status).toBe(200);
    peer.send(head);
    expect(await peer.waitForClose()).toMatchObject({ code: 1008 });
  });

  it('closes the tunnel on data over the credit', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    // The response stays inside the DO and nobody reads its body, so the DO returns no credit.
    const held: Response[] = [];
    const pending = runInDurableObject(stub, async (instance: PreviewTunnel) => {
      const response = await instance.fetch(previewRequest('/unread', { allocationId }));
      held.push(response);
      return { status: response.status };
    });
    const open = await peer.takeType('open');
    peer.send({ type: 'head', stream: open.stream, head: { status: 200, headers: [] } });
    expect((await pending).status).toBe(200);
    const chunk = new Uint8Array(PREVIEW_TUNNEL_DATA_MAX_BYTES);
    for (let sent = 0; sent < PREVIEW_TUNNEL_WINDOW_BYTES; sent += chunk.byteLength) {
      peer.send({ type: 'data', stream: open.stream, bytes: chunk });
    }
    peer.send({ type: 'data', stream: open.stream, bytes: new Uint8Array(1) });
    expect(await peer.waitForClose()).toMatchObject({ code: 1008 });
    const replacement = await connectTunnelPeer(stub, allocationId);
    await roundTrip(stub, replacement, allocationId);
  });
});

describe('PreviewTunnel stream admission', () => {
  it('counts completed unread responses across repeated tunnel replacement', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    await setTunnelLimits(stub, { http: { capacity: 2, maxWaiters: 0, waitMs: 1_000 } });
    const held: Response[] = [];
    for (let index = 0; index < 2; index += 1) {
      const pending = runInDurableObject(stub, async (instance: PreviewTunnel) => {
        const response = await instance.fetch(previewRequest('/unread', { allocationId }));
        held.push(response);
        return response.status;
      });
      const open = await peer.takeType('open');
      peer.send({ type: 'head', stream: open.stream, head: { status: 200, headers: [] } });
      expect(await pending).toBe(200);
      // Complete inside the DO so transport buffering cannot consume the held body.
      await runInDurableObject(stub, async (instance: PreviewTunnel, state) => {
        const socket = state.getWebSockets('tunnel')[0];
        if (socket === undefined) throw new Error('Expected the admitted tunnel');
        const bytes = new Uint8Array(PREVIEW_TUNNEL_DATA_MAX_BYTES).fill(index + 1);
        for (let sent = 0; sent < PREVIEW_TUNNEL_WINDOW_BYTES; sent += bytes.length) {
          await instance.webSocketMessage(
            socket,
            encodePreviewTunnelFrame({ type: 'data', stream: open.stream, bytes }).buffer
          );
        }
        await instance.webSocketMessage(
          socket,
          encodePreviewTunnelFrame({ type: 'end', stream: open.stream }).buffer
        );
      });
    }
    let replacement = peer;
    for (let index = 0; index < 3; index += 1) {
      replacement = await connectTunnelPeer(stub, allocationId);
      await expectFailure(
        await stub.fetch(previewRequest('/blocked', { allocationId })),
        503,
        PREVIEW_TOO_MANY_STREAMS_TEXT
      );
      expect(replacement.opens).toBe(0);
    }
    await runInDurableObject(stub, async () => {
      const actual = new Uint8Array(await held[0].arrayBuffer());
      expect(actual).toEqual(new Uint8Array(PREVIEW_TUNNEL_WINDOW_BYTES).fill(1));
    });
    await roundTrip(stub, replacement, allocationId);
    await runInDurableObject(stub, async () => {
      await held[1].body?.cancel();
    });
  });

  it('answers busy when the slots and the wait queue are full', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    await setTunnelLimits(stub, {
      http: { capacity: 1, maxWaiters: 0, waitMs: 1_000 },
    });
    const first = stub.fetch(previewRequest('/first', { allocationId }));
    const open = await peer.takeType('open');
    const busy = await stub.fetch(previewRequest('/second', { allocationId }));
    expect(busy.headers.get('Retry-After')).toBe('1');
    await expectFailure(busy, 503, PREVIEW_TOO_MANY_STREAMS_TEXT);
    peer.respond(open.stream, 200, 'first');
    expect(await (await first).text()).toBe('first');
  });

  it('lets a request wait for a slot, and answers busy when the wait ends', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    await setTunnelLimits(stub, {
      http: { capacity: 1, maxWaiters: 4, waitMs: 300 },
    });
    const first = stub.fetch(previewRequest('/first', { allocationId }));
    const firstOpen = await peer.takeType('open');
    const timedOut = await stub.fetch(previewRequest('/late', { allocationId }));
    await expectFailure(timedOut, 503, PREVIEW_TOO_MANY_STREAMS_TEXT);

    await setTunnelLimits(stub, {
      http: { capacity: 1, maxWaiters: 4, waitMs: 5_000 },
    });
    const waiting = stub.fetch(previewRequest('/waiting', { allocationId }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(peer.opens).toBe(1);
    peer.respond(firstOpen.stream, 200, 'first');
    expect(await (await first).text()).toBe('first');
    const waitingOpen = await peer.takeType('open');
    expect(waitingOpen.open.path).toBe('/waiting');
    peer.respond(waitingOpen.stream, 200, 'waited');
    expect(await (await waiting).text()).toBe('waited');
  });

  it('serves 200 concurrent requests with at most 128 open streams', async () => {
    const { stub, peer, allocationId } = await connectedTunnel();
    expect(PREVIEW_TUNNEL_LIMITS.http.capacity).toBe(PREVIEW_TUNNEL_MAX_HTTP_STREAMS);
    const total = 200;
    const responses = Array.from({ length: total }, (_, index) =>
      stub.fetch(previewRequest(`/module/${index}.js`, { allocationId }))
    );
    // Hold every head until the cap is reached: the other requests must wait.
    const held: number[] = [];
    for (let index = 0; index < PREVIEW_TUNNEL_MAX_HTTP_STREAMS; index += 1) {
      held.push((await peer.takeType('open', undefined, 15_000)).stream);
    }
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(peer.opens).toBe(PREVIEW_TUNNEL_MAX_HTTP_STREAMS);

    let answered = 0;
    const answerAll = (async () => {
      for (const stream of held) peer.respond(stream, 200, `m${stream}`);
      answered = held.length;
      while (answered < total) {
        const open = await peer.takeType('open', undefined, 15_000);
        peer.respond(open.stream, 200, `m${open.stream}`);
        answered += 1;
      }
    })();
    const bodies = await Promise.all(
      responses.map(async pending => {
        const response = await pending;
        expect(response.status).toBe(200);
        return response.text();
      })
    );
    await answerAll;
    expect(bodies.every(body => body.startsWith('m'))).toBe(true);
    expect(peer.opens).toBe(total);
    await waitFor(() => expect(peer.closeInfo()).toBeNull());
  });
});
