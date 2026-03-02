import type { ErrorHandler } from 'hono';

type ErrorHandlerOptions = {
  /** Include `message` (the raw error text) in the JSON response. Default: `true`. */
  includeMessage?: boolean;
};

/**
 * Create a Hono `app.onError` handler that logs the error and returns a 500 JSON response.
 */
export function createErrorHandler(
  logger: { error: (...args: unknown[]) => void } = console,
  options: ErrorHandlerOptions = {}
): ErrorHandler {
  const { includeMessage = true } = options;
  return (err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Unhandled error', {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json(
      includeMessage
        ? { error: 'Internal server error', message: message || 'Unknown error' }
        : { error: 'Internal server error' },
      500
    );
  };
}
