import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { inbound } from '../../src/routes/inbound';
import { MAX_PAYLOAD_SIZE } from '../../src/util/constants';
import type { HonoContext } from '../../src/index';

const CHUNK_BYTES = 16 * 1024;

type ReadState = { pulled: number; cancelled: boolean };

function streamedBody(
  totalBytes: number,
  fill = 0x78
): { stream: ReadableStream<Uint8Array>; read: ReadState } {
  const read: ReadState = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(CHUNK_BYTES).fill(fill);
  let offset = 0;

  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const remaining = totalBytes - offset;
        if (remaining <= 0) {
          controller.close();
          return;
        }
        const size = Math.min(CHUNK_BYTES, remaining);
        offset += size;
        read.pulled = offset;
        controller.enqueue(size === CHUNK_BYTES ? chunk : chunk.slice(0, size));
      },
      cancel() {
        read.cancelled = true;
      },
    },
    // No prefetch: the pulled count then measures the consumer's demand.
    new CountQueuingStrategy({ highWaterMark: 0 })
  );

  return { stream, read };
}

function capturedRequest(stream: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Request('http://localhost/inbound/user/user-1/trigger-1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: stream,
    duplex: 'half',
  } as RequestInit);
}

function createInboundApp() {
  const captured: Array<{ body: string }> = [];
  const env = {
    TRIGGER_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        getAuthConfig: async () => null,
        captureRequest: async (request: { body: string }) => {
          captured.push(request);
          return { success: true, requestId: 'request-1' };
        },
      }),
    },
  } as unknown as Env;
  const app = new Hono<HonoContext>();
  app.route('/inbound', inbound);
  return { app, env, captured };
}

describe('inbound webhook body limit', () => {
  it('rejects an oversized stream once the byte bound is crossed', async () => {
    const { app, env, captured } = createInboundApp();
    const { stream, read } = streamedBody(8 * 1024 * 1024);

    const response = await app.fetch(capturedRequest(stream), env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Payload too large',
    });
    expect(read.pulled).toBeLessThanOrEqual(MAX_PAYLOAD_SIZE + CHUNK_BYTES);
    expect(read.cancelled).toBe(true);
    expect(captured).toHaveLength(0);
  });

  it('accepts a stream of exactly the limit and passes its text through', async () => {
    const { app, env, captured } = createInboundApp();
    const { stream } = streamedBody(MAX_PAYLOAD_SIZE);

    const response = await app.fetch(capturedRequest(stream), env);

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].body).toBe('x'.repeat(MAX_PAYLOAD_SIZE));
  });

  it('decodes a multibyte body whose encoded size is within the limit', async () => {
    const { app, env, captured } = createInboundApp();
    const text = 'é'.repeat(100_000);
    const bytes = new TextEncoder().encode(text);

    const response = await app.fetch(
      new Request('http://localhost/inbound/user/user-1/trigger-1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bytes,
      }),
      env
    );

    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_PAYLOAD_SIZE);
    expect(response.status).toBe(200);
    expect(captured[0].body).toBe(text);
  });

  it('treats a request without a body as an empty body', async () => {
    const { app, env, captured } = createInboundApp();

    const response = await app.fetch(
      new Request('http://localhost/inbound/user/user-1/trigger-1', { method: 'GET' }),
      env
    );

    expect(response.status).toBe(200);
    expect(captured[0].body).toBe('');
  });

  it('rejects a declared length above the limit without reading the stream', async () => {
    const { app, env, captured } = createInboundApp();
    const { stream, read } = streamedBody(8 * 1024 * 1024);

    const response = await app.fetch(
      capturedRequest(stream, { 'Content-Length': String(MAX_PAYLOAD_SIZE + 1) }),
      env
    );

    expect(response.status).toBe(413);
    expect(read.pulled).toBe(0);
    expect(captured).toHaveLength(0);
  });
});
