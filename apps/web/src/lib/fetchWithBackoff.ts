import { captureException } from '@sentry/nextjs';

type FetchWithBackoffOptions = {
  attemptTimeoutMs?: number;
  baseDelayMs?: number;
  maxBackoffDelayMs?: number;
  maxDelayMs?: number;
  retryResponse?: (r: Response) => boolean;
};

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function fetchWithBackoff(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  options?: FetchWithBackoffOptions
): Promise<Response> {
  const baseDelayMs = options?.baseDelayMs ?? 200;
  const maxBackoffDelayMs = options?.maxBackoffDelayMs ?? Number.POSITIVE_INFINITY;
  const maxDelayMs = options?.maxDelayMs ?? 20000;
  const delayFactor = 1.5;
  const startedAt = performance.now();
  const hasElapsed = () => performance.now() - startedAt > maxDelayMs - nextDelay;
  const retryResponse = options?.retryResponse ?? (r => r.status >= 500);

  let nextDelay = baseDelayMs * (1 + (Math.random() - 0.5) / 10);
  while (true) {
    try {
      const attemptTimeoutSignal = options?.attemptTimeoutMs
        ? AbortSignal.timeout(options.attemptTimeoutMs)
        : undefined;
      const signal =
        init?.signal && attemptTimeoutSignal
          ? AbortSignal.any([init.signal, attemptTimeoutSignal])
          : (init?.signal ?? attemptTimeoutSignal);
      const response = await fetch(input, signal ? { ...init, signal } : init);
      if (!retryResponse(response)) {
        return response;
      }
      if (hasElapsed()) {
        let status = -1;
        let statusText = 'failed to even get headers';
        try {
          status = response.status;
          statusText = response.statusText;
        } catch (statusError) {
          //no point in breaking error-handling
          captureException(statusError, {
            tags: { source: 'fetch_with_backoff_status' },
            extra: {
              input: typeof input === 'string' ? input : 'Request object',
              responseAvailable: !!response,
            },
            level: 'info',
          });
        }

        console.warn(
          `Fetch failed after ${performance.now() - startedAt}ms: ${input.toString()}\n${status} ${statusText}`
        );
        return response;
      }
    } catch (err) {
      if (init?.signal?.aborted) {
        throw err;
      }
      if (hasElapsed()) {
        captureException(err, {
          tags: { source: 'fetch_with_backoff' },
          extra: {
            input: typeof input === 'string' ? input : 'Request object',
            elapsedMs: performance.now() - startedAt,
          },
        });
        throw err;
      }
    }
    await delay(nextDelay, init?.signal ?? undefined);
    nextDelay = Math.min(nextDelay * delayFactor, maxBackoffDelayMs);
  }
}
