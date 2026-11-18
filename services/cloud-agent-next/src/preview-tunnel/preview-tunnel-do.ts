import { DurableObject } from 'cloudflare:workers';
import { logger } from '../logger.js';
import { isValidPreviewPort } from '../preview/host.js';
import { getSandboxControlStub } from '../sandbox-control/stub.js';
import {
  PREVIEW_MARKER_ALLOCATION_HEADER,
  PREVIEW_MARKER_PORT_HEADER,
  PREVIEW_MARKER_PREFIX,
  PREVIEW_TUNNEL_CONNECT_HEADER,
} from '../shared/preview-headers.js';
import {
  PREVIEW_TUNNEL_ACCEPT_BACKSTOP_MS,
  PREVIEW_TUNNEL_ACK_TIMEOUT_MS,
  PREVIEW_TUNNEL_CLOSE,
  PREVIEW_TUNNEL_CONNECT_WAIT_MS,
  PREVIEW_TUNNEL_HEAD_BACKSTOP_MS,
  PREVIEW_TUNNEL_MAX_HTTP_STREAMS,
  PREVIEW_TUNNEL_MAX_STREAM_WAITERS,
  PREVIEW_TUNNEL_MAX_WS_STREAMS,
  PREVIEW_TUNNEL_STREAM_WAIT_MS,
  PREVIEW_TUNNEL_WS_ID_BASE,
  PreviewTunnelFrameTooLargeError,
  decodeWorkerTunnelFrame,
  decodeWrapperTunnelFrame,
  encodePreviewTunnelFrame,
  isPreviewTunnelWebSocketId,
  parsePreviewTunnelName,
  type PreviewTunnelFrame,
} from '../shared/preview-tunnel-protocol.js';
import {
  closeWebSocketQuietly,
  sendableCloseCode,
  sendableCloseReason,
} from '../shared/websocket-close.js';
import type { Env } from '../types.js';
import {
  BROWSER_TAG,
  TUNNEL_TAG,
  browserMessageFrame,
  browserStreamId,
  offeredProtocols,
  readTunnelSeq,
  streamTag,
  writeTunnelSeq,
} from './browser-sockets.js';
import { previewTunnelFailureResponse, type PreviewTunnelFailure } from './failures.js';
import { HttpTunnelStream } from './http-stream.js';
import { StreamSlots, type StreamSlotLimits } from './stream-slots.js';
import { TunnelDemand, type PreviewTunnelDemandResult, type TunnelWait } from './tunnel-demand.js';
import { TunnelState, type TunnelStream } from './tunnel-state.js';
import { WebSocketTunnelStream } from './websocket-stream.js';

export type PreviewTunnelLimits = {
  http: StreamSlotLimits;
  webSocket: StreamSlotLimits;
  ackTimeoutMs: number;
  connectWaitMs: number;
  headBackstopMs: number;
  acceptBackstopMs: number;
};

export const PREVIEW_TUNNEL_LIMITS: PreviewTunnelLimits = {
  http: {
    capacity: PREVIEW_TUNNEL_MAX_HTTP_STREAMS,
    maxWaiters: PREVIEW_TUNNEL_MAX_STREAM_WAITERS,
    waitMs: PREVIEW_TUNNEL_STREAM_WAIT_MS,
  },
  webSocket: {
    capacity: PREVIEW_TUNNEL_MAX_WS_STREAMS,
    maxWaiters: PREVIEW_TUNNEL_MAX_STREAM_WAITERS,
    waitMs: PREVIEW_TUNNEL_STREAM_WAIT_MS,
  },
  ackTimeoutMs: PREVIEW_TUNNEL_ACK_TIMEOUT_MS,
  connectWaitMs: PREVIEW_TUNNEL_CONNECT_WAIT_MS,
  headBackstopMs: PREVIEW_TUNNEL_HEAD_BACKSTOP_MS,
  acceptBackstopMs: PREVIEW_TUNNEL_ACCEPT_BACKSTOP_MS,
};

const TUNNEL_CLOSED_REASON = 'Preview tunnel closed';
const UNFORWARDED_HEADERS = new Set(['host', 'upgrade', 'connection']);

type CloseFrame = { code: number; reason: string };
type OpenTarget = { port: number; path: string; headers: [string, string][] };
type Opened<S> = { ok: true; stream: S } | { ok: false; failure: PreviewTunnelFailure };

function tunnelRequestHeaders(headers: Headers): [string, string][] {
  const kept: [string, string][] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (UNFORWARDED_HEADERS.has(lower)) continue;
    if (lower.startsWith('sec-websocket-') || lower.startsWith(PREVIEW_MARKER_PREFIX)) continue;
    kept.push([name, value]);
  }
  return kept;
}

/** The wrapper closes the tunnel on an open it cannot decode, so the DO checks its own first. */
function refusedOpen(frame: PreviewTunnelFrame): PreviewTunnelFailure | null {
  let bytes: Uint8Array;
  try {
    bytes = encodePreviewTunnelFrame(frame);
  } catch (error) {
    if (error instanceof PreviewTunnelFrameTooLargeError) return 'request_too_large';
    throw error;
  }
  return decodeWorkerTunnelFrame(bytes).ok ? null : 'unsupported_request';
}

function sendQuietly(socket: WebSocket, data: string | Uint8Array): void {
  try {
    socket.send(data);
  } catch {
    // The browser left; its close event cleans up.
  }
}

/**
 * The preview tunnel of one allocation, named `<sandboxId>:<allocationId>`.
 * The wrapper connects one binary WebSocket after the Worker admits it; each
 * browser request becomes a stream on that socket. The DO keeps no storage: an
 * HTTP stream lives in memory and keeps the DO awake, and a browser WebSocket
 * lives in its socket tags, so an idle HMR session can hibernate.
 *
 * The wrapper is untrusted. A frame that breaks the protocol closes the
 * tunnel, and no tunnel byte reaches a control path: the only call out is the
 * demand to the Sandbox DO, which carries no tunnel data.
 */
export class PreviewTunnel extends DurableObject<Env> {
  /** Integration tests shorten these. */
  protected limits: PreviewTunnelLimits = PREVIEW_TUNNEL_LIMITS;
  private readonly identity: { sandboxId: string; allocationId: string } | null;
  private tunnel: TunnelState | null = null;
  private nextTunnelSeq = 1;
  private nextHttpId = 1;
  private readonly httpSlots = new StreamSlots(() => this.limits.http);
  private readonly webSocketSlots = new StreamSlots(() => this.limits.webSocket);
  private readonly releasedBrowsers = new WeakSet<WebSocket>();
  private readonly demand = new TunnelDemand<TunnelState>({
    request: () => this.requestTunnel(),
    waitMs: () => this.limits.connectWaitMs,
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.identity = parsePreviewTunnelName(ctx.id.name);
    this.restoreAfterWake();
  }

  async fetch(request: Request): Promise<Response> {
    const identity = this.identity;
    if (identity === null) return new Response('Not found', { status: 404 });
    const port = request.headers.get(PREVIEW_MARKER_PORT_HEADER);
    if (port !== null) return this.proxy(request, identity.allocationId, port);
    const admitted = request.headers.get(PREVIEW_TUNNEL_CONNECT_HEADER);
    if (admitted !== null) return this.connectTunnel(request, identity.allocationId, admitted);
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(socket);
    if (tags.includes(TUNNEL_TAG)) {
      this.onTunnelMessage(socket, message);
      return;
    }
    const id = browserStreamId(tags);
    if (id !== null) this.onBrowserMessage(socket, id, message);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    this.onSocketClosed(socket, code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.onSocketClosed(socket, 1011, 'WebSocket error');
  }

  /** Socket tags and attachments are the only state that survives hibernation. */
  private restoreAfterWake(): void {
    let highest = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const seq = readTunnelSeq(socket);
      if (seq === null) continue;
      highest = Math.max(highest, seq);
      const isTunnel = this.ctx.getTags(socket).includes(TUNNEL_TAG);
      if (!isTunnel || socket.readyState !== WebSocket.OPEN) continue;
      if (this.tunnel === null || seq > this.tunnel.seq) this.tunnel = new TunnelState(socket, seq);
    }
    this.nextTunnelSeq = highest + 1;
    let browsers = 0;
    for (const browser of this.ctx.getWebSockets(BROWSER_TAG)) {
      if (browser.readyState === WebSocket.OPEN) browsers += 1;
      // A closing browser socket gave its slot back before the wake.
      else this.releasedBrowsers.add(browser);
    }
    this.webSocketSlots.restore(browsers);
  }

  private requestTunnel(): Promise<PreviewTunnelDemandResult> {
    const identity = this.identity;
    if (identity === null) return Promise.resolve('not_ready');
    return getSandboxControlStub(this.env, identity.sandboxId).requestPreviewTunnel(
      identity.allocationId
    );
  }

  private connectTunnel(request: Request, allocationId: string, admitted: string): Response {
    if (admitted !== allocationId) {
      return new Response('Preview tunnel allocation mismatch', { status: 403 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    const tunnel = new TunnelState(pair[1], this.nextTunnelSeq);
    this.nextTunnelSeq += 1;
    this.ctx.acceptWebSocket(pair[1], [TUNNEL_TAG]);
    writeTunnelSeq(pair[1], tunnel.seq);
    const previous = this.tunnel;
    this.tunnel = tunnel;
    if (previous !== null) {
      this.dropTunnel(previous, { code: PREVIEW_TUNNEL_CLOSE.replaced, reason: 'Replaced' });
    }
    this.demand.connected(tunnel);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async proxy(
    request: Request,
    allocationId: string,
    portMarker: string
  ): Promise<Response> {
    if (request.headers.get(PREVIEW_MARKER_ALLOCATION_HEADER) !== allocationId) {
      return previewTunnelFailureResponse('not_running');
    }
    const port = /^\d{1,5}$/.test(portMarker) ? Number(portMarker) : Number.NaN;
    if (!isValidPreviewPort(port)) return previewTunnelFailureResponse('reserved');
    const url = new URL(request.url);
    const target: OpenTarget = {
      port,
      path: `${url.pathname}${url.search}`,
      headers: tunnelRequestHeaders(request.headers),
    };
    return request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
      ? this.proxyWebSocket(request, target)
      : this.proxyHttp(request, target);
  }

  private async proxyHttp(request: Request, target: OpenTarget): Promise<Response> {
    const method = request.method;
    const openFrame = (stream: number): PreviewTunnelFrame => ({
      type: 'open',
      stream,
      open: { ...target, method },
    });
    const refused = refusedOpen(openFrame(1));
    if (refused !== null) return previewTunnelFailureResponse(refused);
    if (!(await this.httpSlots.acquire())) return previewTunnelFailureResponse('busy');
    let release: (() => void) | null = () => this.httpSlots.release();
    try {
      const opened = await this.openStream(
        tunnel => new HttpTunnelStream(this.nextHttpStreamId(tunnel), tunnel, method),
        openFrame
      );
      if (!opened.ok) return previewTunnelFailureResponse(opened.failure);
      const stream = opened.stream;
      stream.adoptSlot(release);
      release = null;
      stream.startHeadBackstop(this.limits.headBackstopMs);
      void stream.sendRequestBody(request.body);
      const head = await stream.headResult();
      return head.ok ? head.response : previewTunnelFailureResponse(head.failure);
    } finally {
      release?.();
    }
  }

  private async proxyWebSocket(request: Request, target: OpenTarget): Promise<Response> {
    const protocols = offeredProtocols(request.headers.get('Sec-WebSocket-Protocol'));
    const openFrame = (stream: number): PreviewTunnelFrame => ({
      type: 'ws_open',
      stream,
      open: { ...target, protocols },
    });
    const refused = refusedOpen(openFrame(PREVIEW_TUNNEL_WS_ID_BASE));
    if (refused !== null) return previewTunnelFailureResponse(refused);
    if (!(await this.webSocketSlots.acquire())) return previewTunnelFailureResponse('busy');
    let release: (() => void) | null = () => this.webSocketSlots.release();
    try {
      const opened = await this.openStream(tunnel => {
        const id = this.nextWebSocketId(tunnel);
        return new WebSocketTunnelStream(id, tunnel, {
          offered: protocols,
          accept: protocol => this.acceptBrowser(tunnel, id, protocol),
        });
      }, openFrame);
      if (!opened.ok) return previewTunnelFailureResponse(opened.failure);
      opened.stream.startAcceptBackstop(this.limits.acceptBackstopMs);
      const result = await opened.stream.opened();
      if (!result.ok) return previewTunnelFailureResponse(result.failure);
      // The browser socket keeps the slot now; its close frees it.
      release = null;
      return result.response;
    } finally {
      release?.();
    }
  }

  /**
   * Sends the open and waits for the wrapper's acknowledgement. A tunnel that
   * sent no frame since the open is dead: the DO closes it, asks for a new one
   * and tries once more. A tunnel that sent other frames is alive but slow, so
   * the stream goes on and its head or accept backstop bounds the wait.
   */
  private async openStream<S extends TunnelStream>(
    create: (tunnel: TunnelState) => S,
    openFrame: (stream: number) => PreviewTunnelFrame
  ): Promise<Opened<S>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const wait = await this.currentOrDemandedTunnel();
      if (!wait.ok) return { ok: false, failure: wait.reason };
      const tunnel = wait.tunnel;
      const stream = create(tunnel);
      tunnel.streams.set(stream.id, stream);
      const heard = tunnel.framesReceived;
      if (!tunnel.send(openFrame(stream.id))) {
        this.dropTunnel(tunnel, { code: 1011, reason: TUNNEL_CLOSED_REASON });
        continue;
      }
      const outcome = await stream.ack.wait(this.limits.ackTimeoutMs);
      if (outcome === 'acked') return { ok: true, stream };
      if (outcome === 'failed') return { ok: false, failure: 'unavailable' };
      if (outcome === 'timeout' && tunnel.framesReceived > heard) return { ok: true, stream };
      if (outcome === 'timeout') {
        this.dropTunnel(tunnel, { code: PREVIEW_TUNNEL_CLOSE.noAck, reason: 'No acknowledgement' });
      }
    }
    return { ok: false, failure: 'unavailable' };
  }

  private currentOrDemandedTunnel(): Promise<TunnelWait<TunnelState>> {
    if (this.tunnel !== null) return Promise.resolve({ ok: true, tunnel: this.tunnel });
    return this.demand.wait();
  }

  private nextHttpStreamId(tunnel: TunnelState): number {
    for (;;) {
      const id = this.nextHttpId;
      this.nextHttpId = id + 1 >= PREVIEW_TUNNEL_WS_ID_BASE ? 1 : id + 1;
      if (!tunnel.streams.has(id) && !tunnel.recent.has(id)) return id;
    }
  }

  private nextWebSocketId(tunnel: TunnelState): number {
    for (;;) {
      const [random = 0] = crypto.getRandomValues(new Uint32Array(1));
      const id = PREVIEW_TUNNEL_WS_ID_BASE + (random >>> 1);
      if (tunnel.streams.has(id) || tunnel.recent.has(id)) continue;
      if (this.ctx.getWebSockets(streamTag(id)).length === 0) return id;
    }
  }

  private acceptBrowser(tunnel: TunnelState, id: number, protocol: string): Response {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [BROWSER_TAG, streamTag(id)]);
    writeTunnelSeq(pair[1], tunnel.seq);
    const headers = new Headers();
    if (protocol !== '') headers.set('Sec-WebSocket-Protocol', protocol);
    return new Response(null, { status: 101, webSocket: pair[0], headers });
  }

  private currentTunnelOf(socket: WebSocket): TunnelState | null {
    const tunnel = this.tunnel;
    return tunnel !== null && readTunnelSeq(socket) === tunnel.seq ? tunnel : null;
  }

  private onTunnelMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    // A replaced tunnel's streams already ended, so its late frames are dropped.
    const tunnel = this.currentTunnelOf(socket);
    if (tunnel === null) return;
    if (typeof message === 'string') {
      this.dropTunnel(tunnel, {
        code: PREVIEW_TUNNEL_CLOSE.unsupportedData,
        reason: 'Preview tunnel frames are binary',
      });
      return;
    }
    const decoded = decodeWrapperTunnelFrame(message);
    if (!decoded.ok) {
      this.dropTunnel(tunnel, decoded.violation);
      return;
    }
    tunnel.framesReceived += 1;
    const violation = this.dispatch(tunnel, decoded.frame);
    if (violation !== null) {
      this.dropTunnel(tunnel, { code: PREVIEW_TUNNEL_CLOSE.violation, reason: violation });
    }
  }

  private dispatch(tunnel: TunnelState, frame: PreviewTunnelFrame): string | null {
    const stream = tunnel.streams.get(frame.stream);
    if (stream !== undefined) return stream.onFrame(frame);
    if (tunnel.recent.has(frame.stream)) return null;
    if (isPreviewTunnelWebSocketId(frame.stream)) {
      const browser = this.ctx
        .getWebSockets(streamTag(frame.stream))
        .find(candidate => readTunnelSeq(candidate) === tunnel.seq);
      if (browser !== undefined) return this.relayToBrowser(tunnel, browser, frame);
    }
    return 'Preview tunnel frame names a stream that is not open';
  }

  private relayToBrowser(
    tunnel: TunnelState,
    browser: WebSocket,
    frame: PreviewTunnelFrame
  ): string | null {
    switch (frame.type) {
      case 'ws_text':
        sendQuietly(browser, frame.text);
        return null;
      case 'ws_binary':
        sendQuietly(browser, frame.bytes.slice());
        return null;
      case 'ws_close':
        tunnel.recent.add(frame.stream);
        this.closeBrowser(browser, frame.code, frame.reason);
        return null;
      case 'credit':
        return null;
      default:
        return 'Preview tunnel frame does not match a WebSocket stream';
    }
  }

  private onBrowserMessage(socket: WebSocket, id: number, message: string | ArrayBuffer): void {
    const tunnel = this.currentTunnelOf(socket);
    if (tunnel === null) {
      this.closeBrowser(socket, 1011, TUNNEL_CLOSED_REASON);
      return;
    }
    if (tunnel.recent.has(id)) return;
    const frame = browserMessageFrame(id, message);
    if (frame === null) {
      const tooBig = { code: PREVIEW_TUNNEL_CLOSE.tooBig, reason: 'Message too large' };
      tunnel.recent.add(id);
      tunnel.send({ type: 'ws_close', stream: id, ...tooBig });
      this.closeBrowser(socket, tooBig.code, tooBig.reason);
      return;
    }
    if (!tunnel.send(frame)) this.closeBrowser(socket, 1011, TUNNEL_CLOSED_REASON);
  }

  private onSocketClosed(socket: WebSocket, code: number, reason: string): void {
    const tags = this.ctx.getTags(socket);
    if (tags.includes(TUNNEL_TAG)) {
      const tunnel = this.currentTunnelOf(socket);
      if (tunnel !== null) this.dropTunnel(tunnel, null);
      closeWebSocketQuietly(socket, code, reason);
      return;
    }
    const id = browserStreamId(tags);
    if (id === null) return;
    const tunnel = this.currentTunnelOf(socket);
    if (tunnel !== null && !tunnel.recent.has(id)) {
      tunnel.recent.add(id);
      tunnel.send({
        type: 'ws_close',
        stream: id,
        code: sendableCloseCode(code),
        reason: sendableCloseReason(reason),
      });
    }
    this.closeBrowser(socket, code, reason);
  }

  private closeBrowser(socket: WebSocket, code: number, reason: string): void {
    closeWebSocketQuietly(socket, code, reason);
    if (this.releasedBrowsers.has(socket)) return;
    this.releasedBrowsers.add(socket);
    this.webSocketSlots.release();
  }

  /** Ends every stream of a tunnel; a drop after the head errors the body, never a clean end. */
  private dropTunnel(tunnel: TunnelState, close: CloseFrame | null): void {
    if (this.tunnel?.seq === tunnel.seq) this.tunnel = null;
    if (close !== null) closeWebSocketQuietly(tunnel.socket, close.code, close.reason);
    const streams = [...tunnel.streams.values()];
    for (const stream of streams) stream.fail();
    let browsers = 0;
    for (const browser of this.ctx.getWebSockets(BROWSER_TAG)) {
      if (readTunnelSeq(browser) !== tunnel.seq) continue;
      browsers += 1;
      this.closeBrowser(browser, 1011, TUNNEL_CLOSED_REASON);
    }
    logger
      .withFields({
        closeCode: close?.code ?? null,
        closeReason: close?.reason ?? null,
        streams: streams.length,
        browserSockets: browsers,
      })
      .info('Preview tunnel ended');
  }
}
