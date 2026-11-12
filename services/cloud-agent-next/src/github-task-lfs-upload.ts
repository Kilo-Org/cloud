import { createHash } from 'node:crypto';
import type { GitHubLfsObject } from '@kilocode/worker-utils/github-task-lfs';

/** Hold the last byte until EOF confirms both size and digest. Storage cannot complete early. */
function validatedObject(
  body: ReadableStream<unknown>,
  object: GitHubLfsObject,
  signal: AbortSignal
) {
  const hash = createHash('sha256');
  const reader = body.getReader();
  let size = 0;
  let last: Uint8Array | undefined;
  let cancellation: Promise<void> | undefined;
  const cancel = (reason: unknown) =>
    (cancellation ??= reader.cancel(reason).catch(() => undefined));
  // Workerd's JavaScript stream pipes do not reliably cancel a pending read from a signal.
  const abort = () => {
    void cancel(signal.reason);
  };
  const release = () => {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  };
  signal.addEventListener('abort', abort, { once: true });
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          while (true) {
            signal.throwIfAborted();
            const result = await reader.read();
            signal.throwIfAborted();
            if (result.done) {
              if (size !== object.size) throw new Error('GitHub LFS object size mismatch');
              if (hash.digest('hex') !== object.oid)
                throw new Error('GitHub LFS object digest mismatch');
              if (last) controller.enqueue(last);
              release();
              controller.close();
              return;
            }
            const chunk = result.value;
            if (!(chunk instanceof Uint8Array)) throw new Error('Invalid GitHub LFS upload stream');
            size += chunk.byteLength;
            if (size > object.size) throw new Error('GitHub LFS object size mismatch');
            if (!chunk.byteLength) continue;
            hash.update(chunk);
            const emitsBytes = last !== undefined || chunk.byteLength > 1;
            if (last) controller.enqueue(last);
            if (chunk.byteLength > 1) controller.enqueue(chunk.subarray(0, -1));
            last = chunk.slice(-1);
            if (emitsBytes) return;
          }
        } catch (error) {
          await cancel(error);
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        await cancel(reason);
        release();
      },
    },
    { highWaterMark: 0 }
  );
}

/** A missing target means GitHub already has this object. Still validate the caller's bytes. */
export async function uploadGitHubLfsObject(
  request: Request,
  object: GitHubLfsObject,
  target?: { url: URL; headers: Headers }
): Promise<void> {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(120_000)]);
  const body = validatedObject(
    request.body ?? new ReadableStream({ start: controller => controller.close() }),
    object,
    signal
  );
  // Empty objects have no final byte to withhold. Confirm EOF before issuing their PUT.
  if (!target || object.size === 0) {
    await body.pipeTo(new WritableStream());
    if (!target) return;
  }
  const fixed = new FixedLengthStream(object.size);
  const pump = object.size === 0 ? fixed.writable.close() : body.pipeTo(fixed.writable);
  const send = (async () => {
    const response = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: fixed.readable,
      redirect: 'manual',
      signal,
      ...{ duplex: 'half' },
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('GitHub LFS storage upload unavailable');
  })();
  try {
    await Promise.all([pump, send]);
  } catch (error) {
    abort.abort();
    await Promise.allSettled([pump, send]);
    throw error;
  }
}
