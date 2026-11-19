import {
  previewResponseHasNoBody,
  type PreviewTunnelFrame,
  type PreviewTunnelHead,
  type PreviewTunnelResetCode,
} from '../shared/preview-tunnel-protocol.js';
import { CreditGate, InboundBody, pumpBody } from '../shared/preview-tunnel-stream.js';
import { failureForReset, type PreviewTunnelFailure } from './failures.js';
import { AckWait, type TunnelPort, type TunnelStream } from './tunnel-state.js';

export type HttpStreamHead =
  | { ok: true; response: Response }
  | { ok: false; failure: PreviewTunnelFailure };

function streamClosed(): Error {
  return new Error('Preview stream closed');
}

/**
 * One HTTP request on the tunnel. The request body goes out within the
 * wrapper's credit. The response body waits in an `InboundBody`, and its
 * credit goes back when the browser reads. The stream keeps its slot until the
 * browser has the whole body, so the Durable Object holds at most one window
 * for each slot.
 */
export class HttpTunnelStream implements TunnelStream {
  readonly ack = new AckWait();
  private readonly gate = new CreditGate();
  private readonly head: Promise<HttpStreamHead>;
  private resolveHead!: (head: HttpStreamHead) => void;
  private headSettled = false;
  private headSeen = false;
  private body: InboundBody | null = null;
  private ended = false;
  private done = false;
  private backstop: ReturnType<typeof setTimeout> | null = null;
  private releaseSlot: (() => void) | null = null;

  constructor(
    readonly id: number,
    private readonly tunnel: TunnelPort,
    private readonly method: string
  ) {
    this.head = new Promise(resolve => {
      this.resolveHead = resolve;
    });
  }

  get finished(): boolean {
    return this.done;
  }

  headResult(): Promise<HttpStreamHead> {
    return this.head;
  }

  /** The stream keeps the request's slot from now on and frees it when it ends. */
  adoptSlot(release: () => void): void {
    if (this.done) release();
    else this.releaseSlot = release;
  }

  startHeadBackstop(ms: number): void {
    if (this.done || this.headSeen) return;
    this.backstop = setTimeout(() => {
      this.backstop = null;
      if (this.done || this.headSeen) return;
      this.tunnel.send({ type: 'reset', stream: this.id, code: 'cancelled' });
      this.failLocally('timeout');
    }, ms);
  }

  /** Sends the request body within the credit, then the end. */
  async sendRequestBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
    if (this.done) return;
    if (body !== null) {
      try {
        await pumpBody(body, this.gate, bytes => {
          if (!this.tunnel.send({ type: 'data', stream: this.id, bytes })) throw streamClosed();
        });
      } catch {
        if (this.done) return;
        this.tunnel.send({ type: 'reset', stream: this.id, code: 'cancelled' });
        this.failLocally('unavailable');
        return;
      }
    }
    if (!this.done) this.tunnel.send({ type: 'end', stream: this.id });
  }

  onFrame(frame: PreviewTunnelFrame): string | null {
    this.ack.ack();
    switch (frame.type) {
      case 'credit':
        return this.gate.grant(frame.bytes) ? null : 'Preview tunnel credit is over the window';
      case 'head':
        return this.onHead(frame.head);
      case 'data':
        if (this.body === null || this.ended) return 'Preview tunnel data has no open body';
        return this.body.push(frame.bytes) ? null : 'Preview tunnel data is over the credit';
      case 'end':
        return this.onEnd();
      case 'reset':
        this.onReset(frame.code);
        return null;
      default:
        return 'Preview tunnel frame does not match an HTTP stream';
    }
  }

  fail(): void {
    this.ack.fail();
    this.failLocally('unavailable');
  }

  private onHead(head: PreviewTunnelHead): string | null {
    if (this.headSeen) return 'Preview tunnel head is repeated';
    this.headSeen = true;
    this.clearBackstop();
    let headers: Headers;
    try {
      headers = new Headers(head.headers);
    } catch {
      // The dev server sent a header that a Worker response cannot carry.
      this.tunnel.send({ type: 'reset', stream: this.id, code: 'bad_response' });
      this.failLocally('bad_response');
      return null;
    }
    if (previewResponseHasNoBody(this.method, head.status)) {
      this.settleHead({ ok: true, response: new Response(null, { status: head.status, headers }) });
      return null;
    }
    const body = new InboundBody({
      onConsumed: bytes => {
        if (!this.ended && !this.done) this.tunnel.send({ type: 'credit', stream: this.id, bytes });
      },
      onCancel: () => {
        if (this.done) return;
        if (!this.ended) this.tunnel.send({ type: 'reset', stream: this.id, code: 'cancelled' });
        this.finish();
      },
      onClosed: () => this.finish(),
    });
    this.body = body;
    this.settleHead({
      ok: true,
      response: new Response(body.stream, { status: head.status, headers }),
    });
    return null;
  }

  private onEnd(): string | null {
    if (!this.headSeen || this.ended) return 'Preview tunnel end has no open body';
    this.ended = true;
    if (this.body === null) this.finish();
    else this.body.end();
    return null;
  }

  private onReset(code: PreviewTunnelResetCode): void {
    if (this.ended) return;
    this.settleHead({ ok: false, failure: failureForReset(code) });
    this.body?.fail(new Error('The preview server reset the stream'));
    this.finish();
  }

  private failLocally(failure: PreviewTunnelFailure): void {
    if (this.ended && this.body !== null) {
      // A completed response still owns its slot while the browser retains its data.
      this.gate.fail(streamClosed());
      return;
    }
    this.settleHead({ ok: false, failure });
    this.body?.fail(streamClosed());
    this.finish();
  }

  private settleHead(head: HttpStreamHead): void {
    if (this.headSettled) return;
    this.headSettled = true;
    this.resolveHead(head);
  }

  private clearBackstop(): void {
    if (this.backstop === null) return;
    clearTimeout(this.backstop);
    this.backstop = null;
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.clearBackstop();
    this.settleHead({ ok: false, failure: 'unavailable' });
    this.gate.fail(streamClosed());
    this.tunnel.finish(this.id);
    const release = this.releaseSlot;
    this.releaseSlot = null;
    release?.();
  }
}
