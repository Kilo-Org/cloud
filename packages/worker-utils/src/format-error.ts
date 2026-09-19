/**
 * Normalize a thrown value to a human-readable message string.
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Format an error for structured logging with message and optional stack trace.
 */
export function formatError(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) {
    return { error: error.message, stack: error.stack };
  }
  return { error: getErrorMessage(error) };
}
