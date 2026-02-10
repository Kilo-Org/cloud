/**
 * Durable Object retry utility.
 *
 * Creates a fresh stub for each retry attempt as recommended by Cloudflare,
 * since certain errors can break the stub. Only retries when
 * error.retryable === true (infrastructure errors). Never retries
 * error.overloaded === true.
 *
 * Copied from cloudflare-webhook-agent-ingest/src/util/do-retry.ts
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
 * const result = await withDORetry(
 *   () => env.KILOCLAW_INSTANCE.get(env.KILOCLAW_INSTANCE.idFromName(userId)),
 *   (stub) => stub.start(),
 *   'start'
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

      // Only retry on .retryable === true (never on .overloaded or app errors)
      if (!isRetryableError(error)) {
        console.warn(
          '[do-retry] Non-retryable error',
          operationName,
          `attempt=${attempt + 1}`,
          lastError.message
        );
        throw lastError;
      }

      // Check if we have retries left
      if (attempt + 1 >= config.maxAttempts) {
        console.error(
          '[do-retry] All retries exhausted',
          operationName,
          `attempts=${attempt + 1}`,
          lastError.message
        );
        throw lastError;
      }

      // Calculate backoff and wait
      const backoffMs = calculateBackoff(attempt, config);
      console.warn(
        '[do-retry] Retrying',
        operationName,
        `attempt=${attempt + 1}`,
        `backoff=${Math.round(backoffMs)}ms`,
        lastError.message
      );

      await scheduler.wait(backoffMs);
    }
  }

  throw lastError ?? new Error('Unexpected retry loop exit');
}
