import { env, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import {
  PREVIEW_TUNNEL_LIMITS,
  type PreviewTunnel,
  type PreviewTunnelLimits,
} from '../../../src/preview-tunnel/preview-tunnel-do.js';
import {
  PREVIEW_MARKER_ALLOCATION_HEADER,
  PREVIEW_MARKER_PORT_HEADER,
  PREVIEW_TUNNEL_CONNECT_HEADER,
} from '../../../src/shared/preview-headers.js';
import {
  decodeWorkerTunnelFrame,
  encodePreviewTunnelFrame,
  previewTunnelName,
  type PreviewTunnelFrame,
} from '../../../src/shared/preview-tunnel-protocol.js';

export type PreviewTunnelStub = DurableObjectStub<PreviewTunnel>;

const tunnels = (env as unknown as { PREVIEW_TUNNEL: DurableObjectNamespace<PreviewTunnel> })
  .PREVIEW_TUNNEL;

export function previewTunnelStub(sandboxId: string, allocationId: string): PreviewTunnelStub {
  return tunnels.getByName(previewTunnelName(sandboxId, allocationId));
}

/** A fresh tunnel identity, so no test sees another test's Durable Object. */
export function newTunnelIdentity(): { sandboxId: string; allocationId: string } {
  const suffix = crypto.randomUUID().replaceAll('-', '');
  return { sandboxId: `sbx_tunnel_${suffix}`, allocationId: `alloc_${suffix}` };
}

export async function setTunnelLimits(
  stub: PreviewTunnelStub,
  patch: Partial<PreviewTunnelLimits>
): Promise<void> {
  await runInDurableObject(stub, instance => {
    Object.assign(instance, { limits: { ...PREVIEW_TUNNEL_LIMITS, ...patch } });
  });
}

export type PreviewRequestInit = RequestInit & { port?: string; allocationId: string };

/** A browser request as the preview route forwards it, with the Worker-set markers. */
export function previewRequest(path: string, init: PreviewRequestInit): Request {
  const headers = new Headers(init.headers);
  headers.set(PREVIEW_MARKER_PORT_HEADER, init.port ?? '3000');
  headers.set(PREVIEW_MARKER_ALLOCATION_HEADER, init.allocationId);
  return new Request(`https://preview.test${path}`, { ...init, headers });
}

/** Builds a frame without the encoder's bounds, as an untrusted wrapper can. */
export function rawTunnelFrame(type: number, stream: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, stream);
  out.set(payload, 5);
  return out;
}

type FrameWaiter = {
  match: (frame: PreviewTunnelFrame) => boolean;
  resolve: (frame: PreviewTunnelFrame | null) => void;
};

/**
 * The wrapper's end of a tunnel, driven by the test. By default it
 * acknowledges each open with zero credit, as the real wrapper does.
 */
export class TunnelPeer {
  autoAck = true;
  readonly unparsed: unknown[] = [];
  private readonly queued: PreviewTunnelFrame[] = [];
  private readonly waiters: FrameWaiter[] = [];
  private readonly closeWaiters: Array<(close: { code: number; reason: string }) => void> = [];
  private closed: { code: number; reason: string } | null = null;
  private openCount = 0;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => this.onMessage(event.data));
    socket.addEventListener('close', event => {
      this.closed = { code: event.code, reason: event.reason };
      for (const waiter of this.waiters.splice(0)) waiter.resolve(null);
      for (const resolve of this.closeWaiters.splice(0)) resolve(this.closed);
    });
    socket.addEventListener('error', () => undefined);
  }

  /** How many HTTP and WebSocket opens this peer received. */
  get opens(): number {
    return this.openCount;
  }

  send(frame: PreviewTunnelFrame): void {
    this.socket.send(encodePreviewTunnelFrame(frame));
  }

  sendRaw(data: string | Uint8Array): void {
    this.socket.send(data);
  }

  respond(stream: number, status: number, body?: string, headers: [string, string][] = []): void {
    this.send({ type: 'head', stream, head: { status, headers } });
    if (body !== undefined && body.length > 0) {
      this.send({ type: 'data', stream, bytes: new TextEncoder().encode(body) });
    }
    this.send({ type: 'end', stream });
  }

  /** Takes the first queued or next frame that matches. */
  take(
    match: (frame: PreviewTunnelFrame) => boolean,
    timeoutMs = 5_000
  ): Promise<PreviewTunnelFrame | null> {
    const index = this.queued.findIndex(match);
    if (index >= 0) return Promise.resolve(this.queued.splice(index, 1)[0] ?? null);
    if (this.closed !== null) return Promise.resolve(null);
    return new Promise(resolve => {
      const waiter: FrameWaiter = {
        match,
        resolve: frame => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        resolve(null);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async takeType<T extends PreviewTunnelFrame['type']>(
    type: T,
    stream?: number,
    timeoutMs?: number
  ): Promise<Extract<PreviewTunnelFrame, { type: T }>> {
    const frame = await this.take(
      candidate => candidate.type === type && (stream === undefined || candidate.stream === stream),
      timeoutMs
    );
    if (frame === null) throw new Error(`The tunnel peer got no ${type} frame`);
    return frame as Extract<PreviewTunnelFrame, { type: T }>;
  }

  /** Frames that arrived and that no `take` consumed. */
  pending(): readonly PreviewTunnelFrame[] {
    return [...this.queued];
  }

  closeInfo(): { code: number; reason: string } | null {
    return this.closed;
  }

  waitForClose(timeoutMs = 5_000): Promise<{ code: number; reason: string } | null> {
    if (this.closed !== null) return Promise.resolve(this.closed);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.closeWaiters.push(close => {
        clearTimeout(timer);
        resolve(close);
      });
    });
  }

  close(code = 1000, reason = ''): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  private onMessage(data: unknown): void {
    if (typeof data === 'string') {
      this.unparsed.push(data);
      return;
    }
    const decoded = decodeWorkerTunnelFrame(new Uint8Array(data as ArrayBuffer));
    if (!decoded.ok) {
      this.unparsed.push(decoded.violation);
      return;
    }
    const frame = decoded.frame;
    if (frame.type === 'open' || frame.type === 'ws_open') {
      this.openCount += 1;
      if (this.autoAck) this.send({ type: 'credit', stream: frame.stream, bytes: 0 });
    }
    const waiter = this.waiters.find(candidate => candidate.match(frame));
    if (waiter === undefined) {
      this.queued.push(frame);
      return;
    }
    this.waiters.splice(this.waiters.indexOf(waiter), 1);
    waiter.resolve(frame);
  }
}

/** The peer for a 101 answer to a tunnel connect. */
export function tunnelPeerFrom(response: Response): TunnelPeer {
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error('The tunnel connect returned no socket');
  // The compatibility date makes Blob the default; the wrapper reads ArrayBuffer.
  socket.binaryType = 'arraybuffer';
  socket.accept();
  return new TunnelPeer(socket);
}

/** Connects the wrapper's tunnel socket as the admitted Worker route does. */
export async function connectTunnelPeer(
  stub: PreviewTunnelStub,
  allocationId: string
): Promise<TunnelPeer> {
  const response = await stub.fetch('https://tunnel.test/', {
    headers: { Upgrade: 'websocket', [PREVIEW_TUNNEL_CONNECT_HEADER]: allocationId },
  });
  return tunnelPeerFrom(response);
}
