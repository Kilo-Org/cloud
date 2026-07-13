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
  it('accepts bytes exactly at the declared limit', async () => {
    const { stream, cancel } = streamFromChunks([
      [1, 2],
      [3, 4],
    ]);

    await expect(readBoundedStream(stream, 4)).resolves.toEqual({
      ok: true,
      bytes: Uint8Array.from([1, 2, 3, 4]),
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('rejects actual bytes over the declared size', async () => {
    const { stream } = streamFromChunks([[1, 2, 3]]);

    await expect(readBoundedStream(stream, 2)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
  });

  it('detects overflow accumulated across multiple chunks', async () => {
    const { stream, cancel } = streamFromChunks([[1, 2], [3, 4], [5]]);

    await expect(readBoundedStream(stream, 4)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels on actual-byte overflow and releases the reader lock', async () => {
    const { stream, cancel } = streamFromChunks([[1, 2, 3]]);

    await readBoundedStream(stream, 2);

    expect(cancel).toHaveBeenCalledOnce();
    expect(() => stream.getReader()).not.toThrow();
  });

  it('preserves every byte and chunk ordering', async () => {
    const { stream } = streamFromChunks([[0, 255], [], [17, 42, 128]]);

    await expect(readBoundedStream(stream, 5)).resolves.toEqual({
      ok: true,
      bytes: Uint8Array.from([0, 255, 17, 42, 128]),
    });
  });
});
