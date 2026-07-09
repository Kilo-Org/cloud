import { describe, expect, it, vi } from 'vitest';

import { readBoundedStream } from './bounded-stream-reader';

function streamFromChunks(chunks: number[][], cancel = vi.fn()) {
  let nextChunk = 0;
  return {
    stream: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[nextChunk];
          if (chunk === undefined) {
            controller.close();
            return;
          }
          nextChunk += 1;
          controller.enqueue(Uint8Array.from(chunk));
        },
        cancel,
      },
      { highWaterMark: 0 }
    ),
    cancel,
  };
}

describe('readBoundedStream', () => {
  it('accepts bytes exactly at both limits', async () => {
    const { stream, cancel } = streamFromChunks([
      [1, 2],
      [3, 4],
    ]);

    await expect(readBoundedStream(stream, 4, 4)).resolves.toEqual({
      ok: true,
      bytes: Uint8Array.from([1, 2, 3, 4]),
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('rejects actual bytes over the declared size', async () => {
    const { stream } = streamFromChunks([[1, 2, 3]]);

    await expect(readBoundedStream(stream, 2, 10)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'declared_bytes',
    });
  });

  it('rejects a declaration over the configured cap without consuming bytes', async () => {
    let pulled = false;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(Uint8Array.from([1]));
      },
      cancel,
    });

    await expect(readBoundedStream(stream, 11, 10)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'configured_cap',
    });
    expect(pulled).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('detects overflow accumulated across multiple chunks', async () => {
    const { stream, cancel } = streamFromChunks([[1, 2], [3, 4], [5]]);

    await expect(readBoundedStream(stream, 4, 10)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      limit: 'declared_bytes',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels on actual-byte overflow and releases the reader lock', async () => {
    const { stream, cancel } = streamFromChunks([[1, 2, 3]]);

    await readBoundedStream(stream, 2, 10);

    expect(cancel).toHaveBeenCalledOnce();
    expect(() => stream.getReader()).not.toThrow();
  });

  it('preserves every byte and chunk ordering', async () => {
    const { stream } = streamFromChunks([[0, 255], [], [17, 42, 128]]);

    await expect(readBoundedStream(stream, 5, 10)).resolves.toEqual({
      ok: true,
      bytes: Uint8Array.from([0, 255, 17, 42, 128]),
    });
  });
});
