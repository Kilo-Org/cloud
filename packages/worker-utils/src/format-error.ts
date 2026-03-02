/**
 * Format an error for structured logging with message and optional stack trace.
 */
export function formatError(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) {
    return { error: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
