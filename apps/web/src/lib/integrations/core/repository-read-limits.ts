import { z } from 'zod';

export const REPOSITORY_READ_LIMITS = {
  pages: 2,
  repositories: 50,
  responseBytes: 1024 * 1024,
  timeoutMs: 30_000,
} as const;

// Omitted options preserve complete legacy reads until those callers retire.
// Bounded results can be incomplete and must not replace a complete shared cache.
export type RepositoryReadOptions = { bounded?: boolean; signal?: AbortSignal };

export const repositoryPageSchema = z.custom<unknown[]>(
  value => Array.isArray(value) && value.length <= REPOSITORY_READ_LIMITS.repositories,
  'Invalid repository page'
);

export async function withRepositoryReadDeadline<T>(
  options: RepositoryReadOptions | undefined,
  read: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  if (!options?.bounded) return read();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error('Repository fetch timed out')),
    REPOSITORY_READ_LIMITS.timeoutMs
  );
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([read(signal), aborted.promise]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

export async function boundRepositoryResponse(
  response: Response,
  signal?: AbortSignal
): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const length = response.headers.get('content-length');
    if (
      length &&
      (!/^\d+$/.test(length) || Number(length) > REPOSITORY_READ_LIMITS.responseBytes)
    ) {
      throw new Error('Repository response exceeded size limit');
    }
    if (
      response.ok &&
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
        'application/json'
    ) {
      throw new Error('Invalid repository response content type');
    }
    const bytes = new Uint8Array(REPOSITORY_READ_LIMITS.responseBytes);
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('Invalid repository response');
      if (size + chunk.value.byteLength > bytes.byteLength) {
        throw new Error('Repository response exceeded size limit');
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    return new Response(text, response);
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function boundedRepositoryFetch(signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    signal.throwIfAborted();
    return boundRepositoryResponse(
      await fetch(input, { ...init, signal, redirect: 'error' }),
      signal
    );
  };
}
