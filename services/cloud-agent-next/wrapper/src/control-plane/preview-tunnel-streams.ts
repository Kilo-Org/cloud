import {
  PreviewTunnelFrameTooLargeError,
  previewResponseHasNoBody,
  type PreviewTunnelFrame,
  type PreviewTunnelOpen,
  type PreviewTunnelResetCode,
  type PreviewTunnelWebSocketOpen,
} from '../../../src/shared/preview-tunnel-protocol.js';
import { CreditGate, InboundBody, pumpBody } from '../../../src/shared/preview-tunnel-stream.js';
import {
  closeWebSocketQuietly,
  sendableCloseCode,
  sendableCloseReason,
} from '../../../src/shared/websocket-close.js';
import type { PreviewForwarder, PreviewForwardFailure } from './preview-forwarder.js';

/**
 * The wrapper end of one tunnel stream. The tunnel acknowledges the open
 * before `start`, so the Durable Object knows the tunnel is alive while the
 * loopback connect runs.
 */

/** What a stream needs from its tunnel. `send` is false when the tunnel is gone. */
export type TunnelStreamPort = {
  send(frame: PreviewTunnelFrame): boolean;
  /** The stream is over; the tunnel forgets its id. */
  finish(id: number): void;
};

export type WrapperTunnelStream = {
  readonly id: number;
  start(): Promise<void>;
  /** A frame from the Durable Object; a string is a violation that closes the tunnel. */
  onFrame(frame: PreviewTunnelFrame): string | null;
  /** The tunnel closed. */
  fail(): void;
};

function resetCode(failure: PreviewForwardFailure): PreviewTunnelResetCode {
  return failure === 'invalid' ? 'protocol' : failure;
}

/** The head header list; `Headers` iteration joins `set-cookie`, so it goes one by one. */
function headerList(headers: Headers): [string, string][] {
  const list: [string, string][] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'set-cookie') list.push([name, value]);
  }
  for (const cookie of headers.getSetCookie()) list.push(['set-cookie', cookie]);
  return list;
}

/**
 * One HTTP request. The request body arrives within the wrapper's credit and
 * waits in an `InboundBody` until the loopback fetch reads it. The response
 * body goes out within the Durable Object's credit.
 */
export class HttpWrapperStream implements WrapperTunnelStream {
  private readonly abort = new AbortController();
  private readonly gate = new CreditGate();
  private readonly requestBody: InboundBody;
  private done = false;

  constructor(
    readonly id: number,
    private readonly open: PreviewTunnelOpen,
    private readonly port: TunnelStreamPort,
    private readonly forwarder: PreviewForwarder
  ) {
    this.requestBody = new InboundBody({
      onConsumed: bytes => {
        if (!this.done) this.port.send({ type: 'credit', stream: this.id, bytes });
      },
      onCancel: () => undefined,
    });
  }

  async start(): Promise<void> {
    const result = await this.forwarder.fetch({
      port: this.open.port,
      method: this.open.method,
      path: this.open.path,
      headers: new Headers(this.open.headers),
      body: this.requestBody.stream,
      signal: this.abort.signal,
    });
    if (this.done) {
      if (result.ok) void result.value.body?.cancel().catch(() => undefined);
      return;
    }
    if (!result.ok) return this.reset(resetCode(result.reason));
    await this.respond(result.value);
  }

  onFrame(frame: PreviewTunnelFrame): string | null {
    switch (frame.type) {
      case 'data':
        return this.requestBody.push(frame.bytes)
          ? null
          : 'Preview request data is over the credit';
      case 'end':
        this.requestBody.end();
        return null;
      case 'credit':
        return this.gate.grant(frame.bytes) ? null : 'Preview response credit is over the window';
      case 'reset':
        this.finish();
        return null;
      default:
        return 'Preview tunnel frame does not match an HTTP stream';
    }
  }

  fail(): void {
    this.finish();
  }

  private async respond(response: Response): Promise<void> {
    const body = previewResponseHasNoBody(this.open.method, response.status) ? null : response.body;
    if (response.status < 200 || response.status > 599) {
      void response.body?.cancel().catch(() => undefined);
      return this.reset('bad_response');
    }
    const head = { status: response.status, headers: headerList(response.headers) };
    try {
      if (!this.port.send({ type: 'head', stream: this.id, head })) return this.finish();
    } catch (error) {
      if (!(error instanceof PreviewTunnelFrameTooLargeError)) throw error;
      void response.body?.cancel().catch(() => undefined);
      return this.reset('bad_response');
    }
    if (body !== null) {
      try {
        await pumpBody(body, this.gate, bytes => {
          if (!this.port.send({ type: 'data', stream: this.id, bytes })) {
            throw new Error('Preview tunnel closed');
          }
        });
      } catch {
        // The stream ended first, or the dev server broke the body.
        if (!this.done) this.reset('bad_response');
        return;
      }
    } else {
      void response.body?.cancel().catch(() => undefined);
    }
    if (this.done) return;
    this.port.send({ type: 'end', stream: this.id });
    this.finish();
  }

  private reset(code: PreviewTunnelResetCode): void {
    if (this.done) return;
    this.port.send({ type: 'reset', stream: this.id, code });
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    const closed = new Error('Preview stream closed');
    this.abort.abort(closed);
    this.requestBody.fail(closed);
    this.gate.fail(closed);
    this.port.finish(this.id);
  }
}

/** One WebSocket. Messages pass both ways without credit, as on the Containers path. */
export class WebSocketWrapperStream implements WrapperTunnelStream {
  private socket: WebSocket | null = null;
  private done = false;

  constructor(
    readonly id: number,
    private readonly open: PreviewTunnelWebSocketOpen,
    private readonly port: TunnelStreamPort,
    private readonly forwarder: PreviewForwarder
  ) {}

  async start(): Promise<void> {
    const result = await this.forwarder.openSocket({
      port: this.open.port,
      path: this.open.path,
      headers: new Headers(this.open.headers),
      protocols: this.open.protocols,
    });
    if (this.done) {
      if (result.ok) closeWebSocketQuietly(result.value, 1001, '');
      return;
    }
    if (!result.ok) {
      this.port.send({ type: 'reset', stream: this.id, code: resetCode(result.reason) });
      return this.finish();
    }
    const socket = result.value;
    this.socket = socket;
    socket.addEventListener('message', event => this.relayUp(event.data as string | ArrayBuffer));
    socket.addEventListener('close', event => {
      if (this.done) return;
      this.port.send({
        type: 'ws_close',
        stream: this.id,
        code: sendableCloseCode(event.code),
        reason: sendableCloseReason(event.reason),
      });
      this.finish();
    });
    this.port.send({ type: 'ws_accept', stream: this.id, protocol: socket.protocol });
  }

  onFrame(frame: PreviewTunnelFrame): string | null {
    const socket = this.socket;
    if (frame.type === 'reset') {
      this.finish();
      return null;
    }
    if (socket === null) return 'Preview tunnel frame came before the WebSocket accept';
    switch (frame.type) {
      case 'ws_text':
        socket.send(frame.text);
        return null;
      case 'ws_binary':
        // The codec decoded it from the ArrayBuffer of the tunnel message.
        socket.send(frame.bytes as Uint8Array<ArrayBuffer>);
        return null;
      case 'ws_close':
        this.finish(frame.code, frame.reason);
        return null;
      default:
        return 'Preview tunnel frame does not match a WebSocket stream';
    }
  }

  fail(): void {
    this.finish(1001, 'Preview tunnel closed');
  }

  private relayUp(data: string | ArrayBuffer): void {
    if (this.done) return;
    const frame: PreviewTunnelFrame =
      typeof data === 'string'
        ? { type: 'ws_text', stream: this.id, text: data }
        : { type: 'ws_binary', stream: this.id, bytes: new Uint8Array(data) };
    try {
      this.port.send(frame);
    } catch (error) {
      if (!(error instanceof PreviewTunnelFrameTooLargeError)) throw error;
      const tooBig = { code: 1009, reason: 'Preview message is too large' };
      this.port.send({ type: 'ws_close', stream: this.id, ...tooBig });
      this.finish(tooBig.code, tooBig.reason);
    }
  }

  private finish(code = 1000, reason = ''): void {
    if (this.done) return;
    this.done = true;
    if (this.socket !== null) closeWebSocketQuietly(this.socket, code, reason);
    this.port.finish(this.id);
  }
}
