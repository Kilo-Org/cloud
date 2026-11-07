import type { ErrorHandler } from 'hono';
import { createErrorHandler } from '@kilocode/worker-utils';
import { buildTrpcErrorResponse } from './trpc-error.js';
import { extractProcedureName } from './balance-validation.js';

type ErrorLogger = { error: (...args: unknown[]) => void };

/**
 * tRPC clients cannot parse the generic JSON error body, so failures raised before the
 * tRPC adapter runs (auth, balance) must still return a tRPC error envelope on `/trpc/*`.
 */
export function createWorkerErrorHandler(logger: ErrorLogger): ErrorHandler {
  const fallback = createErrorHandler(logger, { includeMessage: false });
  return (err, c) => {
    const pathname = new URL(c.req.url).pathname;
    if (!pathname.startsWith('/trpc/')) return fallback(err, c);

    logger.error('Unhandled error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return buildTrpcErrorResponse(
      500,
      'Internal server error',
      extractProcedureName(pathname) ?? undefined
    );
  };
}
