// Cloudflare Workers provides scheduler.wait() for cooperative delays.
// Not in standard webworker lib types.
declare const scheduler:
  | undefined
  | { wait(ms: number, options?: { signal?: AbortSignal }): Promise<void> };

export type DORetryScope = {
  deadlineAt: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};

export type DORetryConfig = {
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  scope?: DORetryScope;
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

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (typeof scheduler !== 'undefined' && 'wait' in scheduler) {
    return signal ? scheduler.wait(ms, { signal }) : scheduler.wait(ms);
  }
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function createRetryScope({ deadlineAt, signal, assertCurrent }: DORetryScope) {
  if (!Number.isFinite(deadlineAt))
    throw new RangeError('Durable Object retry deadlineAt must be finite');

  const controller = new AbortController();
  const deadlineError = new DOMException('Durable Object retry deadline exceeded', 'TimeoutError');
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timeoutId = setTimeout(
    () => controller.abort(deadlineError),
    Math.max(0, deadlineAt - Date.now())
  );

  return {
    deadlineAt,
    signal: controller.signal,
    assertActive() {
      if (Date.now() >= deadlineAt) controller.abort(deadlineError);
      controller.signal.throwIfAborted();
      try {
        assertCurrent?.();
      } catch (error) {
        controller.abort(error);
        throw error;
      }
      if (Date.now() >= deadlineAt) controller.abort(deadlineError);
      controller.signal.throwIfAborted();
    },
    dispose() {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function waitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });

  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
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
  const scope = config.scope ? createRetryScope(config.scope) : undefined;

  try {
    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
      scope?.assertActive();
      try {
        // Create fresh stub for each attempt
        const stub = getStub();
        scope?.assertActive();
        const result = scope
          ? await waitWithSignal(operation(stub), scope.signal)
          : await operation(stub);
        scope?.assertActive();
        return result;
      } catch (error) {
        scope?.assertActive();
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
        const requestedBackoffMs = calculateBackoff(attempt, config);
        const backoffMs = scope
          ? Math.min(requestedBackoffMs, Math.max(0, scope.deadlineAt - Date.now()))
          : requestedBackoffMs;
        logger.warn('[do-retry] Retrying', {
          operation: operationName,
          attempt: attempt + 1,
          backoffMs: Math.round(backoffMs),
          error: lastError.message,
        });

        scope?.assertActive();
        try {
          await waitMs(backoffMs, scope?.signal);
        } finally {
          scope?.assertActive();
        }
      }
    }

    throw lastError ?? new Error('Unexpected retry loop exit');
  } finally {
    scope?.dispose();
  }
}
