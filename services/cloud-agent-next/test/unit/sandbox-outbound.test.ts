import { expect, it, vi } from 'vitest';
import { readBoundedRequestBodyBytes } from '../../src/bounded-request-body.js';

const CAP = 1024;

function streamOf(chunks: Array<Uint8Array | 'stall'>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        if (chunk === 'stall') return;
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function body(chunks: Array<Uint8Array | 'stall'>): Request {
  return new Request('https://example.test/git-upload-pack', {
    method: 'POST',
    body: streamOf(chunks),
    // @ts-expect-error -- Node fetch needs duplex for streaming request bodies
    duplex: 'half',
  });
}

function chunkOf(bytes: number, fill = 1): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

it('returns undefined when the body exceeds the byte cap', async () => {
  const request = body([chunkOf(CAP), chunkOf(1, 2)]);
  await expect(readBoundedRequestBodyBytes(request, CAP)).resolves.toBeUndefined();
});

it('returns the exact bytes of an under-cap chunked body', async () => {
  const request = body([chunkOf(300, 1), chunkOf(200, 2), chunkOf(100, 3)]);
  const result = await readBoundedRequestBodyBytes(request, CAP);
  expect(result).toBeInstanceOf(Uint8Array);
  expect(result?.byteLength).toBe(600);
  expect(result?.at(0)).toBe(1);
  expect(result?.at(299)).toBe(1);
  expect(result?.at(300)).toBe(2);
  expect(result?.at(599)).toBe(3);
});

it('coalesces tiny and empty chunks into the fixed buffer', async () => {
  const chunks: Array<Uint8Array | 'stall'> = [];
  for (let i = 0; i < 240; i++) {
    if (i % 2 === 0) chunks.push(new Uint8Array(0));
    else chunks.push(chunkOf(8, i % 251));
  }
  const request = body(chunks);
  const result = await readBoundedRequestBodyBytes(request, CAP);
  expect(result?.byteLength).toBe(960);
  const bufferCapacity = (result as Uint8Array).buffer.byteLength;
  expect(bufferCapacity).toBeLessThanOrEqual(CAP);
});

it('accepts a single chunk larger than the current buffer when it fits the cap', async () => {
  const request = body([chunkOf(700, 5)]);
  const result = await readBoundedRequestBodyBytes(request, CAP);
  expect(result?.byteLength).toBe(700);
  expect(result?.at(699)).toBe(5);
});

it('applies the empty-read bound to a long run of empty chunks', async () => {
  const chunks: Array<Uint8Array | 'stall'> = [];
  for (let i = 0; i < 5000; i++) chunks.push(new Uint8Array(0));
  chunks.push(chunkOf(4, 1));
  const request = body(chunks);
  await expect(readBoundedRequestBodyBytes(request, CAP)).resolves.toBeUndefined();
});

it('gives up at the read deadline when the body stalls mid-read', async () => {
  vi.useFakeTimers();
  try {
    const request = body([chunkOf(16, 7), 'stall']);
    const pending = readBoundedRequestBodyBytes(request, CAP, 5_000);
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(pending).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it('gives up when the stream errors instead of hanging', async () => {
  const erroring = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunkOf(4, 1));
      controller.error(new Error('upstream reset'));
    },
  });
  const request = new Request('https://example.test/git-upload-pack', {
    method: 'POST',
    body: erroring,
    // @ts-expect-error -- Node fetch needs duplex for streaming request bodies
    duplex: 'half',
  });
  await expect(readBoundedRequestBodyBytes(request, CAP)).resolves.toBeUndefined();
});

it('returns undefined for a bodyless request', async () => {
  const request = new Request('https://example.test/git-upload-pack', { method: 'GET' });
  await expect(readBoundedRequestBodyBytes(request, CAP)).resolves.toBeUndefined();
});
