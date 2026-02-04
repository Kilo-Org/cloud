import { logger } from '../logger.js';

/**
 * Configuration for DO retry behavior
 */
export type DORetryConfig = {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
};

const DEFAULT_CONFIG: DORetryConfig = {
  maxAttempts: 3,
  baseBackoffMs: 100,
  maxBackoffMs: 5000,
};

/**
 * Type for errors that may have Cloudflare's retryable property
 */
type RetryableError = Error & { retryable?: boolean };

/**
 * Check if an error is retryable based on Cloudflare's .retryable property.
 *
 * Per Cloudflare docs: JavaScript Errors with .retryable set to true are
 * suggested to be retried for idempotent operations.
 *
 * We only check the documented .retryable property, not error message strings,
 * as message formats are undocumented and could change.
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
 * @returns The result of the operation
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const metadata = await withDORetry(
 *   () => env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(key)),
 *   (stub) => stub.getMetadata(),
 *   'getMetadata'
 * );
 * ```
 */
export async function withDORetry<TStub, TResult>(
  getStub: () => TStub,
  operation: (stub: TStub) => Promise<TResult>,
  operationName: string,
  config: DORetryConfig = DEFAULT_CONFIG
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
        logger
          .withFields({
            operation: operationName,
            attempt: attempt + 1,
            error: lastError.message,
            retryable: false,
          })
          .warn('DO operation failed with non-retryable error');
        throw lastError;
      }

      // Check if we have retries left
      if (attempt + 1 >= config.maxAttempts) {
        logger
          .withFields({
            operation: operationName,
            attempts: attempt + 1,
            error: lastError.message,
          })
          .error('DO operation failed after all retry attempts');
        throw lastError;
      }

      // Calculate backoff and wait
      const backoffMs = calculateBackoff(attempt, config);
      logger
        .withFields({
          operation: operationName,
          attempt: attempt + 1,
          backoffMs: Math.round(backoffMs),
          error: lastError.message,
        })
        .warn('DO operation failed, retrying');

      await scheduler.wait(backoffMs);
    }
  }

  // TypeScript: This should never be reached, but satisfies the compiler
  throw lastError ?? new Error('Unexpected retry loop exit');
}
