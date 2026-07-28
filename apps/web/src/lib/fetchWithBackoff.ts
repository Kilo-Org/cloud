import { captureException } from '@sentry/nextjs';

type FetchWithBackoffOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryResponse?: (r: Response) => boolean;
};

export async function fetchWithBackoff(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  options?: FetchWithBackoffOptions
): Promise<Response> {
  const baseDelayMs = options?.baseDelayMs ?? 200;
  const maxDelayMs = options?.maxDelayMs ?? 20000;
  const delayFactor = 1.5;
  const startedAt = performance.now();
  const hasElapsed = () => performance.now() - startedAt > maxDelayMs - nextDelay;
  const retryResponse = options?.retryResponse ?? (r => r.status >= 500);

  let nextDelay = baseDelayMs * (1 + (Math.random() - 0.5) / 10);
  while (true) {
    try {
      const response = await fetch(input, init);
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
    await new Promise(res => setTimeout(res, nextDelay));
    nextDelay = nextDelay * delayFactor;
  }
}
