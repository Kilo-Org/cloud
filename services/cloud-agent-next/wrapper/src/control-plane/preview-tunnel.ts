import {
  decodeWorkerTunnelFrame,
  encodePreviewTunnelFrame,
  isPreviewTunnelWebSocketId,
  PREVIEW_TUNNEL_CLOSE,
  PREVIEW_TUNNEL_IDLE_CLOSE_MS,
  PREVIEW_TUNNEL_MAX_HTTP_STREAMS,
  PREVIEW_TUNNEL_MAX_WS_STREAMS,
  PREVIEW_TUNNEL_MISSED_PONG_LIMIT,
  PREVIEW_TUNNEL_PING_INTERVAL_MS,
  type PreviewTunnelFrame,
} from '../../../src/shared/preview-tunnel-protocol.js';
import { closeWebSocketQuietly } from '../../../src/shared/websocket-close.js';
import type { PreviewForwarder } from './preview-forwarder.js';
import {
  HttpWrapperStream,
  WebSocketWrapperStream,
  type TunnelStreamPort,
  type WrapperTunnelStream,
} from './preview-tunnel-streams.js';

/**
 * The wrapper end of the preview tunnel. A `preview.tunnel` frame on the
 * control connection opens a new tunnel socket to the Worker with the launch
 * credential. Each stream on it goes to a dev server on loopback through the
 * forwarder. The tunnel closes after it has had no stream for a while, and it
 * never reconnects by itself: the next browser request asks again.
 *
 * Preview is not session activity. Nothing here reads or changes the
 * heartbeat, so an open tunnel never keeps a sandbox running.
 */

export type PreviewTunnelLimits = {
  maxHttpStreams: number;
  maxWebSocketStreams: number;
  pingIntervalMs: number;
  missedPongLimit: number;
  idleCloseMs: number;
};

export const PREVIEW_TUNNEL_CLIENT_LIMITS: PreviewTunnelLimits = {
  maxHttpStreams: PREVIEW_TUNNEL_MAX_HTTP_STREAMS,
  maxWebSocketStreams: PREVIEW_TUNNEL_MAX_WS_STREAMS,
  pingIntervalMs: PREVIEW_TUNNEL_PING_INTERVAL_MS,
  missedPongLimit: PREVIEW_TUNNEL_MISSED_PONG_LIMIT,
  idleCloseMs: PREVIEW_TUNNEL_IDLE_CLOSE_MS,
};

/** Bun's client WebSocket: it takes headers and sends protocol pings. */
export type TunnelSocket = WebSocket & { ping(): void };
type TunnelSocketCtor = new (
  url: string,
  options: { headers: Record<string, string> }
) => WebSocket;

function openTunnelSocket(url: string, credential: string): TunnelSocket {
  const Ctor = WebSocket as unknown as TunnelSocketCtor;
  return new Ctor(url, { headers: { Authorization: `Bearer ${credential}` } }) as TunnelSocket;
}

export type PreviewTunnelClientDeps = {
  /** The tunnel URL from `previewTunnelUrl`; null leaves preview off. */
  url: string | null;
  credential: string;
  forwarder: PreviewForwarder;
  log: (message: string) => void;
  limits?: Partial<PreviewTunnelLimits>;
  /** Tests replace the socket. */
  connect?: (url: string, credential: string) => TunnelSocket;
};

export type PreviewTunnelClient = {
  /** The Worker asked for a tunnel: open a new one in place of the current one. */
  demand(): void;
  stop(): void;
  /** The open streams of the current tunnel, or null without a tunnel. */
  openStreams(): number | null;
};

class TunnelConnection {
  private readonly streams = new Map<number, WrapperTunnelStream>();
  private httpStreams = 0;
  private webSocketStreams = 0;
  private missedPongs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly port: TunnelStreamPort = {
    send: frame => this.send(frame),
    finish: id => this.forget(id),
  };

  constructor(
    private readonly socket: TunnelSocket,
    private readonly deps: PreviewTunnelClientDeps,
    private readonly limits: PreviewTunnelLimits,
    private readonly onClosed: (connection: TunnelConnection) => void
  ) {
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => this.onOpen());
    socket.addEventListener('message', event => this.onMessage(event.data));
    socket.addEventListener('pong', () => {
      this.missedPongs = 0;
    });
    socket.addEventListener('close', event => {
      if (!this.closed) deps.log(`preview tunnel closed by the Worker: ${event.code}`);
      this.shutDown();
    });
    socket.addEventListener('error', () => this.close(1011, 'Preview tunnel error'));
  }

  get openStreams(): number {
    return this.streams.size;
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    closeWebSocketQuietly(this.socket, code, reason);
    this.shutDown();
  }

  private onOpen(): void {
    if (this.closed) return;
    this.pingTimer = setInterval(() => this.ping(), this.limits.pingIntervalMs);
    this.armIdle();
  }

  private ping(): void {
    if (this.missedPongs >= this.limits.missedPongLimit) {
      this.close(1001, 'Preview tunnel pong timeout');
      return;
    }
    this.missedPongs += 1;
    try {
      this.socket.ping();
    } catch {
      this.close(1001, 'Preview tunnel ping failed');
    }
  }

  private send(frame: PreviewTunnelFrame): boolean {
    if (this.closed) return false;
    const bytes = encodePreviewTunnelFrame(frame);
    try {
      this.socket.send(bytes);
      return true;
    } catch {
      this.close(1011, 'Preview tunnel send failed');
      return false;
    }
  }

  private onMessage(data: unknown): void {
    if (this.closed) return;
    if (!(data instanceof ArrayBuffer)) {
      this.close(PREVIEW_TUNNEL_CLOSE.unsupportedData, 'Preview tunnel text is not allowed');
      return;
    }
    const decoded = decodeWorkerTunnelFrame(data);
    if (!decoded.ok) {
      this.close(decoded.violation.code, decoded.violation.reason);
      return;
    }
    const violation = this.dispatch(decoded.frame);
    if (violation !== null) this.close(PREVIEW_TUNNEL_CLOSE.violation, violation);
  }

  private dispatch(frame: PreviewTunnelFrame): string | null {
    if (frame.type === 'open' || frame.type === 'ws_open') return this.openStream(frame);
    // A frame for a stream that ended here is late, not a violation.
    return this.streams.get(frame.stream)?.onFrame(frame) ?? null;
  }

  private openStream(
    frame: Extract<PreviewTunnelFrame, { type: 'open' | 'ws_open' }>
  ): string | null {
    const id = frame.stream;
    const webSocket = frame.type === 'ws_open';
    if (isPreviewTunnelWebSocketId(id) !== webSocket) return 'Preview stream id has the wrong kind';
    if (this.streams.has(id)) return 'Preview stream id is already open';
    const full = webSocket
      ? this.webSocketStreams >= this.limits.maxWebSocketStreams
      : this.httpStreams >= this.limits.maxHttpStreams;
    if (full) {
      // The reset is also the acknowledgement.
      this.send({ type: 'reset', stream: id, code: 'busy' });
      return null;
    }
    // Acknowledge before the loopback connect, so a slow dev server never looks like a dead tunnel.
    if (!this.send({ type: 'credit', stream: id, bytes: 0 })) return null;
    const stream =
      frame.type === 'ws_open'
        ? new WebSocketWrapperStream(id, frame.open, this.port, this.deps.forwarder)
        : new HttpWrapperStream(id, frame.open, this.port, this.deps.forwarder);
    this.streams.set(id, stream);
    if (webSocket) this.webSocketStreams += 1;
    else this.httpStreams += 1;
    this.clearIdle();
    void stream.start().catch(error => {
      this.deps.log(`preview stream failed: ${error instanceof Error ? error.name : 'error'}`);
      stream.fail();
    });
    return null;
  }

  private forget(id: number): void {
    if (!this.streams.delete(id)) return;
    if (isPreviewTunnelWebSocketId(id)) this.webSocketStreams -= 1;
    else this.httpStreams -= 1;
    this.armIdle();
  }

  private armIdle(): void {
    if (this.closed || this.streams.size > 0 || this.idleTimer !== null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.streams.size === 0) this.close(PREVIEW_TUNNEL_CLOSE.idle, 'Preview tunnel idle');
    }, this.limits.idleCloseMs);
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private shutDown(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdle();
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const stream of streams) stream.fail();
    this.onClosed(this);
  }
}

export function createPreviewTunnelClient(deps: PreviewTunnelClientDeps): PreviewTunnelClient {
  const limits = { ...PREVIEW_TUNNEL_CLIENT_LIMITS, ...deps.limits };
  const connect = deps.connect ?? openTunnelSocket;
  let current: TunnelConnection | null = null;
  let stopped = false;

  return {
    demand() {
      if (stopped) return;
      if (deps.url === null) {
        deps.log('preview tunnel requested, but the control URL has no tunnel form');
        return;
      }
      // The Worker asks only when it has no live tunnel, so the current one is stale.
      current?.close(1000, 'Preview tunnel replaced');
      let socket: TunnelSocket;
      try {
        socket = connect(deps.url, deps.credential);
      } catch {
        deps.log('preview tunnel connect failed');
        return;
      }
      const connection = new TunnelConnection(socket, deps, limits, closed => {
        if (current === closed) current = null;
      });
      current = connection;
    },
    stop() {
      stopped = true;
      current?.close(1001, 'Preview tunnel stopped');
      current = null;
    },
    openStreams() {
      return current?.openStreams ?? null;
    },
  };
}
