import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBoundedStream } from './bounded-stream-reader';

function fromChunks(chunks: number[][], cancel = vi.fn()) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
    },
    cancel,
  });
}

afterEach(() => vi.restoreAllMocks());

describe('readBoundedStream', () => {
  it.each(['resolve', 'reject'] as const)(
    'returns overflow and releases the lock before deferred cancellation can %s',
    async outcome => {
      const cleanup = Promise.withResolvers<void>();
      const cancel = vi.fn(() => cleanup.promise);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stream = fromChunks([[1, 2], [3]], cancel);
      let result: Awaited<ReturnType<typeof readBoundedStream>> | undefined;
      const reading = readBoundedStream(stream, 2).then(value => {
        result = value;
      });
      try {
        await vi.waitFor(() => expect(result).toEqual({ ok: false, reason: 'too_large' }));
        expect(cancel).toHaveBeenCalledExactlyOnceWith('stream exceeded ingest byte limit');
        expect(stream.locked).toBe(false);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        if (outcome === 'reject') {
          const error = new Error('sensitive cancellation details');
          error.name = 'sensitive custom error name';
          cleanup.reject(error);
        } else {
          cleanup.resolve();
        }
        await reading;
      }
      if (outcome === 'reject') {
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledExactlyOnceWith('bounded stream cancellation failed', {
            error_name: 'Error',
          })
        );
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
    }
  );

  it('cancels immediate overflow once and releases its lock', async () => {
    const cancel = vi.fn();
    const stream = fromChunks([[1, 2, 3]], cancel);
    await expect(readBoundedStream(stream, 2)).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('concatenates chunks in order at the exact byte cap', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of [[0, 255], [], [17, 42, 128]])
          controller.enqueue(Uint8Array.from(chunk));
        controller.close();
      },
      cancel,
    });
    await expect(readBoundedStream(stream, 5)).resolves.toEqual({
      ok: true,
      bytes: Uint8Array.from([0, 255, 17, 42, 128]),
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });

  it('propagates read errors and releases its lock', async () => {
    const error = new Error('synthetic read failure');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(error);
      },
    });
    await expect(readBoundedStream(stream, 2)).rejects.toBe(error);
    expect(stream.locked).toBe(false);
  });
});
