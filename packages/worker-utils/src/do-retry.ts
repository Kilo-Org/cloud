// Cloudflare Workers provides scheduler.wait() for cooperative delays.
// Not in standard webworker lib types.
declare const scheduler: undefined | { wait(ms: number): Promise<void> };

export type DORetryConfig = {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
};

export const DEFAULT_DO_RETRY_CONFIG: DORetryConfig = {
  maxAttempts: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 5000,
};

type RetryableError = Error & { retryable?: boolean };

/**
 * Check if an error is retryable based on Cloudflare's .retryable property.
 *
 * Per Cloudflare docs: JavaScript Errors with .retryable set to true are
 * suggested to be retried for idempotent operations.
 *
 * We only check the documented .retryable property, not error message strings,
 * as message formats are undocumented and could change.
 *
 * Note: errors with .overloaded === true are NOT retried — only .retryable matters.
 */
function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as RetryableError).retryable === true;
}

/**
 * Calculate backoff with jitter using exponential backoff formula.
 * Formula: min(maxBackoff, baseBackoff * random * 2^attempt)
 *
 * The random multiplier provides jitter to prevent thundering herd.
 */
function calculateBackoff(attempt: number, config: DORetryConfig): number {
  const exponentialBackoff = config.baseBackoffMs * Math.pow(2, attempt);
  const jitteredBackoff = exponentialBackoff * Math.random();
  return Math.min(config.maxBackoffMs, jitteredBackoff);
}

function waitMs(ms: number): Promise<void> {
  if (typeof scheduler !== 'undefined' && 'wait' in scheduler) {
    return scheduler.wait(ms);
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}

type DORetryLogger = {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};

/**
 * Execute a Durable Object operation with retry logic.
 *
 * Creates a fresh stub for each retry attempt as recommended by Cloudflare,
 * since certain errors can break the stub.
 *
 * @param getStub - Function that returns a fresh DurableObjectStub
 * @param operation - Function that performs the DO operation using the stub
 * @param operationName - Name for logging purposes
 * @param config - Optional retry configuration override
 * @param logger - Optional logger (defaults to console)
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const metadata = await withDORetry(
 *   () => env.MY_DO.get(env.MY_DO.idFromName(key)),
 *   (stub) => stub.getMetadata(),
 *   'getMetadata'
 * );
 * ```
 */
export async function withDORetry<TStub, TResult>(
  getStub: () => TStub,
  operation: (stub: TStub) => Promise<TResult>,
  operationName: string,
  config: DORetryConfig = DEFAULT_DO_RETRY_CONFIG,
  logger: DORetryLogger = console
): Promise<TResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      // Create fresh stub for each attempt
      const stub = getStub();
      return await operation(stub);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (!isRetryableError(error)) {
        logger.warn('[do-retry] Non-retryable error', {
          operation: operationName,
          attempt: attempt + 1,
          error: lastError.message,
          retryable: false,
        });
        throw lastError;
      }

      // Check if we have retries left
      if (attempt + 1 >= config.maxAttempts) {
        logger.error('[do-retry] All retry attempts exhausted', {
          operation: operationName,
          attempts: attempt + 1,
          error: lastError.message,
        });
        throw lastError;
      }

      // Calculate backoff and wait
      const backoffMs = calculateBackoff(attempt, config);
      logger.warn('[do-retry] Retrying', {
        operation: operationName,
        attempt: attempt + 1,
        backoffMs: Math.round(backoffMs),
        error: lastError.message,
      });

      await waitMs(backoffMs);
    }
  }

  throw lastError ?? new Error('Unexpected retry loop exit');
}
