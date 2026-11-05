/**
 * The typed worker failures of the paged transcript read, and the error the
 * client throws for them.
 *
 * These live apart from the tRPC adapter so the reader-facing error states
 * (`session-terminal-error.ts`) can recognize a failure a retry cannot recover
 * without importing the tRPC client.
 */

/**
 * Message and tRPC-style code for a typed worker failure of the paged read.
 * One source for the preview's error state and the manager's snapshot replay:
 * `retryable_failure` stays retryable, the terminal kinds do not.
 */
export const SESSION_HISTORY_FAILURES = {
  retryable_failure: {
    message: 'Session history temporarily unavailable',
    code: 'INTERNAL_SERVER_ERROR',
  },
  too_large: { message: 'Session history too large to load', code: 'UNPROCESSABLE_CONTENT' },
  invalid_data: { message: 'Session history is unavailable', code: 'UNPROCESSABLE_CONTENT' },
} as const;

/**
 * The failures a retry cannot recover: the stored page is oversize or
 * unreadable, so the same read answers the same way every time. A retryable
 * failure is absent by design — offering Retry for it is correct.
 */
export const TERMINAL_SESSION_HISTORY_FAILURE_MESSAGES: readonly string[] = [
  SESSION_HISTORY_FAILURES.too_large.message,
  SESSION_HISTORY_FAILURES.invalid_data.message,
];

/** A typed worker failure, carrying the `code` the query error readers classify on. */
export class SessionHistoryFailureError extends Error {
  readonly code: string;

  constructor(failure: { message: string; code: string }) {
    super(failure.message);
    this.code = failure.code;
  }
}
