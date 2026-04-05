import 'server-only';

// Fetch timeout in milliseconds
export const DEFAULT_FETCH_TIMEOUT_MS = 10000;
// Default retry configuration
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_DELAY_MS = 1000;

export type FetchWithTimeoutOptions = {
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // Retry on timeout (AbortError) or network errors
    return error.name === 'AbortError' || error.message.includes('fetch failed');
  }
  return false;
}

/**
 * Fetch with timeout and exponential retry support
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  retryOptions: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
  } = retryOptions;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      const isRetryable = isRetryableError(error);
      const hasRetriesLeft = attempt < maxRetries;

      if (isRetryable && hasRetriesLeft) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        await sleep(delayMs);
        continue;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timeout after ${timeoutMs}ms`);
      }
      throw error;
    }
  }

  throw new Error('Unexpected retry loop exit');
}
