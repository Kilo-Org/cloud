import type { SecretsExecutionContext } from '@kilocode/secrets-client';

/**
 * Hono's `executionCtx` getter throws outside a request context, which is how unit tests call the
 * routes. A missing context only costs the `waitUntil` keep-alive for a bundle revalidation; it
 * never changes which secret a read returns.
 */
export function requestContext(c: {
  executionCtx: SecretsExecutionContext;
}): SecretsExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
