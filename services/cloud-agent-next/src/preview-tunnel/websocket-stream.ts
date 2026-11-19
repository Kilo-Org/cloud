import type { PreviewTunnelFrame } from '../shared/preview-tunnel-protocol.js';
import { failureForReset, type PreviewTunnelFailure } from './failures.js';
import { AckWait, type TunnelPort, type TunnelStream } from './tunnel-state.js';

export type WebSocketOpenResult =
  | { ok: true; response: Response }
  | { ok: false; failure: PreviewTunnelFailure };

/**
 * A browser WebSocket on the tunnel until the wrapper accepts it. The Durable
 * Object accepts the browser socket in the same turn as the accept, so a
 * message that follows the accept has a socket to go to. After the accept the
 * socket tags carry the stream, so the relay survives hibernation.
 */
export class WebSocketTunnelStream implements TunnelStream {
  readonly ack = new AckWait();
  private readonly result: Promise<WebSocketOpenResult>;
  private resolveResult!: (result: WebSocketOpenResult) => void;
  private done = false;
  private backstop: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: number,
    private readonly tunnel: TunnelPort,
    private readonly options: {
      offered: readonly string[];
      /** Accepts the browser socket and returns its 101 response. */
      accept: (protocol: string) => Response;
    }
  ) {
    this.result = new Promise(resolve => {
      this.resolveResult = resolve;
    });
  }

  opened(): Promise<WebSocketOpenResult> {
    return this.result;
  }

  startAcceptBackstop(ms: number): void {
    if (this.done) return;
    this.backstop = setTimeout(() => {
      this.backstop = null;
      if (this.done) return;
      this.tunnel.send({ type: 'reset', stream: this.id, code: 'cancelled' });
      this.end({ ok: false, failure: 'timeout' });
    }, ms);
  }

  onFrame(frame: PreviewTunnelFrame): string | null {
    this.ack.ack();
    switch (frame.type) {
      case 'credit':
        // The open acknowledgement; a WebSocket stream has no credit.
        return null;
      case 'ws_accept':
        this.onAccept(frame.protocol);
        return null;
      case 'reset':
        this.end({ ok: false, failure: failureForReset(frame.code) });
        return null;
      default:
        return 'Preview tunnel frame came before the WebSocket accept';
    }
  }

  fail(): void {
    this.ack.fail();
    this.end({ ok: false, failure: 'unavailable' });
  }

  private onAccept(protocol: string): void {
    if (this.done) return;
    if (protocol !== '' && !this.options.offered.includes(protocol)) {
      this.tunnel.send({ type: 'reset', stream: this.id, code: 'cancelled' });
      this.end({ ok: false, failure: 'bad_response' });
      return;
    }
    this.settle({ ok: true, response: this.options.accept(protocol) });
    this.tunnel.forget(this.id);
  }

  private end(result: WebSocketOpenResult): void {
    if (this.settle(result)) this.tunnel.finish(this.id);
  }

  private settle(result: WebSocketOpenResult): boolean {
    if (this.done) return false;
    this.done = true;
    if (this.backstop !== null) clearTimeout(this.backstop);
    this.backstop = null;
    this.resolveResult(result);
    return true;
  }
}
