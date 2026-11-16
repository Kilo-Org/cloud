import {
  PREVIEW_TUNNEL_DATA_MAX_BYTES,
  PREVIEW_TUNNEL_WINDOW_BYTES,
} from './preview-tunnel-protocol.js';

/**
 * Credit flow for one direction of one preview tunnel stream. The sender
 * starts with one window of credit and spends it on data frames; the receiver
 * grants credit back when its consumer reads. Both tunnel ends use these.
 */

/** The sender's credit. `take(n)` waits until n bytes of credit exist. */
export class CreditGate {
  private credit = PREVIEW_TUNNEL_WINDOW_BYTES;
  private waiters: Array<() => void> = [];
  private failure: Error | null = null;

  /** Adds a grant; false when it would exceed the window, which is a protocol violation. */
  grant(bytes: number): boolean {
    if (this.credit + bytes > PREVIEW_TUNNEL_WINDOW_BYTES) return false;
    this.credit += bytes;
    this.wake();
    return true;
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.wake();
  }

  async take(bytes: number): Promise<void> {
    while (this.credit < bytes) {
      if (this.failure !== null) throw this.failure;
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    if (this.failure !== null) throw this.failure;
    this.credit -= bytes;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

/**
 * The receiver's body: chunks wait here until the consumer reads, and the
 * credit for a chunk goes back when the consumer takes it. It never holds more
 * than one window, because more is a protocol violation.
 */
export class InboundBody {
  readonly stream: ReadableStream<Uint8Array>;
  private buffer: Uint8Array | null = null;
  private readOffset = 0;
  private queuedBytes = 0;
  private waiter: (() => void) | null = null;
  private ended = false;
  private failure: Error | null = null;

  constructor(callbacks: {
    onConsumed: (bytes: number) => void;
    onCancel: () => void;
    /** The reader took the last chunk after the end. */
    onClosed?: () => void;
  }) {
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: async controller => {
          while (this.queuedBytes === 0 && !this.ended && this.failure === null) {
            await new Promise<void>(resolve => {
              this.waiter = resolve;
            });
          }
          if (this.failure !== null) {
            controller.error(this.failure);
            return;
          }
          if (this.queuedBytes === 0) {
            controller.close();
            callbacks.onClosed?.();
            return;
          }
          const buffer = this.buffer;
          if (buffer === null) throw new Error('Preview body has no receive storage');
          const bytes = Math.min(
            this.queuedBytes,
            PREVIEW_TUNNEL_DATA_MAX_BYTES,
            buffer.length - this.readOffset
          );
          const chunk = buffer.slice(this.readOffset, this.readOffset + bytes);
          this.readOffset = (this.readOffset + bytes) % buffer.length;
          this.queuedBytes -= bytes;
          if (this.queuedBytes === 0) this.release();
          controller.enqueue(chunk);
          callbacks.onConsumed(chunk.byteLength);
        },
        cancel: () => {
          this.ended = true;
          this.release();
          callbacks.onCancel();
        },
      },
      { highWaterMark: 0 }
    );
  }

  get buffered(): number {
    return this.queuedBytes;
  }

  /** Queues a chunk; false when it would exceed the window, which is a protocol violation. */
  push(chunk: Uint8Array): boolean {
    if (this.ended || this.failure !== null) return true;
    if (this.queuedBytes + chunk.byteLength > PREVIEW_TUNNEL_WINDOW_BYTES) return false;
    if (chunk.byteLength === 0) return true;
    // Coalesce frames so one-byte DATA cannot retain one object per byte.
    const buffer = (this.buffer ??= new Uint8Array(PREVIEW_TUNNEL_WINDOW_BYTES));
    const writeOffset = (this.readOffset + this.queuedBytes) % buffer.length;
    const firstBytes = Math.min(chunk.byteLength, buffer.length - writeOffset);
    buffer.set(chunk.subarray(0, firstBytes), writeOffset);
    buffer.set(chunk.subarray(firstBytes), 0);
    this.queuedBytes += chunk.byteLength;
    this.wake();
    return true;
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  /** Errors the body for its reader, so a dropped stream never looks like a clean end. */
  fail(error: Error): void {
    // A body that already ended is complete; its reader keeps the queued data.
    if (this.ended) return;
    this.failure ??= error;
    this.release();
    this.wake();
  }

  private release(): void {
    this.buffer = null;
    this.readOffset = 0;
    this.queuedBytes = 0;
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }
}

/**
 * Sends a body as data frames within the credit of `gate`. It cancels the
 * source when sending fails; the caller sends the end or reset frame.
 */
export async function pumpBody(
  body: ReadableStream<Uint8Array>,
  gate: CreditGate,
  sendData: (chunk: Uint8Array) => void
): Promise<void> {
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      const chunk = next.value;
      for (let offset = 0; offset < chunk.byteLength; offset += PREVIEW_TUNNEL_DATA_MAX_BYTES) {
        const part = chunk.subarray(
          offset,
          Math.min(offset + PREVIEW_TUNNEL_DATA_MAX_BYTES, chunk.byteLength)
        );
        await gate.take(part.byteLength);
        sendData(part);
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
