import { describe, expect, it } from 'vitest';
import {
  decodeWrapperTunnelFrame,
  encodePreviewTunnelFrame,
  PREVIEW_TUNNEL_DATA_MAX_BYTES,
  PREVIEW_TUNNEL_WINDOW_BYTES,
} from './preview-tunnel-protocol.js';
import { CreditGate, InboundBody, pumpBody } from './preview-tunnel-stream.js';

describe('CreditGate', () => {
  it('starts with one window and waits for a grant', async () => {
    const gate = new CreditGate();
    await gate.take(PREVIEW_TUNNEL_WINDOW_BYTES);
    let taken = false;
    const waiting = gate.take(10).then(() => {
      taken = true;
    });
    await Promise.resolve();
    expect(taken).toBe(false);
    expect(gate.grant(10)).toBe(true);
    await waiting;
    expect(taken).toBe(true);
  });

  it('accepts a zero grant and refuses a grant over the window', async () => {
    const gate = new CreditGate();
    expect(gate.grant(0)).toBe(true);
    expect(gate.grant(1)).toBe(false);
    await gate.take(100);
    expect(gate.grant(100)).toBe(true);
    expect(gate.grant(1)).toBe(false);
  });

  it('rejects a waiting take when it fails', async () => {
    const gate = new CreditGate();
    await gate.take(PREVIEW_TUNNEL_WINDOW_BYTES);
    const waiting = gate.take(1);
    gate.fail(new Error('tunnel closed'));
    await expect(waiting).rejects.toThrow('tunnel closed');
  });
});

describe('InboundBody', () => {
  it('grants credit only when the reader takes a chunk', async () => {
    const consumed: number[] = [];
    let closed = 0;
    const body = new InboundBody({
      onConsumed: bytes => consumed.push(bytes),
      onCancel: () => {},
      onClosed: () => {
        closed += 1;
      },
    });
    expect(body.push(new Uint8Array(100))).toBe(true);
    expect(consumed).toEqual([]);
    expect(body.buffered).toBe(100);
    const reader = body.stream.getReader();
    expect((await reader.read()).value?.byteLength).toBe(100);
    expect(consumed).toEqual([100]);
    expect(body.push(new Uint8Array(50))).toBe(true);
    expect(body.buffered).toBe(50);
    body.end();
    expect((await reader.read()).value?.byteLength).toBe(50);
    expect(closed).toBe(0);
    expect((await reader.read()).done).toBe(true);
    expect(consumed).toEqual([100, 50]);
    expect(closed).toBe(1);
  });

  it('coalesces a window of tiny decoded frames into bounded output chunks', async () => {
    const consumed: number[] = [];
    const body = new InboundBody({ onConsumed: bytes => consumed.push(bytes), onCancel: () => {} });
    const expected = Uint8Array.from(
      { length: PREVIEW_TUNNEL_WINDOW_BYTES },
      (_, index) => index % 251
    );
    for (const byte of expected) {
      const decoded = decodeWrapperTunnelFrame(
        encodePreviewTunnelFrame({ type: 'data', stream: 1, bytes: new Uint8Array([byte]) })
      );
      if (!decoded.ok || decoded.frame.type !== 'data' || !body.push(decoded.frame.bytes)) {
        throw new Error('A DATA frame within the receive window must be accepted');
      }
    }
    expect(body.buffered).toBe(PREVIEW_TUNNEL_WINDOW_BYTES);
    expect(consumed).toEqual([]);
    body.end();
    const reader = body.stream.getReader();
    const actual = new Uint8Array(expected.length);
    let offset = 0;
    let chunks = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      actual.set(next.value, offset);
      offset += next.value.length;
      chunks += 1;
    }
    expect(actual).toEqual(expected);
    expect(offset).toBe(expected.length);
    expect(chunks).toBeLessThanOrEqual(PREVIEW_TUNNEL_WINDOW_BYTES / PREVIEW_TUNNEL_DATA_MAX_BYTES);
    expect(consumed.reduce((sum, bytes) => sum + bytes, 0)).toBe(expected.length);
  });

  it('preserves unread and consumed bytes when receive storage wraps', async () => {
    const body = new InboundBody({ onConsumed: () => {}, onCancel: () => {} });
    const initial = new Uint8Array(PREVIEW_TUNNEL_WINDOW_BYTES / 2 + 17).fill(1);
    body.push(initial);
    const reader = body.stream.getReader();
    const first = await reader.read();
    if (first.done) throw new Error('Expected body data');
    const refill = new Uint8Array(
      PREVIEW_TUNNEL_WINDOW_BYTES - initial.length + first.value.length
    ).fill(2);
    for (let offset = 0; offset < refill.length; offset += PREVIEW_TUNNEL_DATA_MAX_BYTES) {
      expect(body.push(refill.subarray(offset, offset + PREVIEW_TUNNEL_DATA_MAX_BYTES))).toBe(true);
    }
    expect(body.push(new Uint8Array(1))).toBe(false);
    body.end();
    const remaining: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(first.value).toEqual(new Uint8Array(first.value.length).fill(1));
    const actual = new Uint8Array(PREVIEW_TUNNEL_WINDOW_BYTES);
    let offset = 0;
    for (const part of remaining) {
      actual.set(part, offset);
      offset += part.length;
    }
    expect(offset).toBe(actual.length);
    expect(actual.subarray(0, initial.length - first.value.length)).toEqual(
      initial.subarray(first.value.length)
    );
    expect(actual.subarray(initial.length - first.value.length)).toEqual(refill);
  });

  it('holds one window and refuses data over it', () => {
    const body = new InboundBody({ onConsumed: () => {}, onCancel: () => {} });
    expect(body.push(new Uint8Array(PREVIEW_TUNNEL_WINDOW_BYTES))).toBe(true);
    expect(body.push(new Uint8Array(1))).toBe(false);
    expect(body.buffered).toBe(PREVIEW_TUNNEL_WINDOW_BYTES);
  });

  it('errors the reader on failure, so a drop never looks like a clean end', async () => {
    const body = new InboundBody({ onConsumed: () => {}, onCancel: () => {} });
    body.push(new Uint8Array(10));
    body.fail(new Error('tunnel closed'));
    expect(body.buffered).toBe(0);
    await expect(body.stream.getReader().read()).rejects.toThrow('tunnel closed');
  });

  it('keeps an ended body complete when the tunnel closes later', async () => {
    const body = new InboundBody({ onConsumed: () => {}, onCancel: () => {} });
    body.push(new Uint8Array(10));
    body.end();
    body.fail(new Error('tunnel closed'));
    expect((await new Response(body.stream).arrayBuffer()).byteLength).toBe(10);
  });

  it('drops queued data and reports a cancel', async () => {
    let cancelled = false;
    const body = new InboundBody({
      onConsumed: () => {},
      onCancel: () => {
        cancelled = true;
      },
    });
    body.push(new Uint8Array(10));
    await body.stream.cancel();
    expect(cancelled).toBe(true);
    expect(body.buffered).toBe(0);
  });
});

describe('pumpBody', () => {
  it('sends data frames of at most 64 KiB within the credit', async () => {
    const gate = new CreditGate();
    const sent: number[] = [];
    const source = new Response(new Uint8Array(PREVIEW_TUNNEL_WINDOW_BYTES + 100_000)).body;
    if (source === null) throw new Error('no body');
    const pumping = pumpBody(source, gate, chunk => sent.push(chunk.byteLength));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(sent.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(
      PREVIEW_TUNNEL_WINDOW_BYTES
    );
    expect(Math.max(...sent)).toBeLessThanOrEqual(PREVIEW_TUNNEL_DATA_MAX_BYTES);
    gate.grant(PREVIEW_TUNNEL_WINDOW_BYTES);
    await pumping;
    expect(sent.reduce((sum, bytes) => sum + bytes, 0)).toBe(PREVIEW_TUNNEL_WINDOW_BYTES + 100_000);
  });

  it('cancels the source when the gate fails', async () => {
    const gate = new CreditGate();
    await gate.take(PREVIEW_TUNNEL_WINDOW_BYTES);
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull: controller => controller.enqueue(new Uint8Array(10)),
      cancel: () => {
        cancelled = true;
      },
    });
    const pumping = pumpBody(source, gate, () => {});
    gate.fail(new Error('tunnel closed'));
    await expect(pumping).rejects.toThrow('tunnel closed');
    expect(cancelled).toBe(true);
  });
});
