/**
 * The typed worker failures of the paged transcript read, and the error the
 * client throws for them.
 *
 * These live apart from the tRPC adapter so the reader-facing error states
 * (`session-terminal-error.ts`) can recognize a failure a retry cannot recover
 * without importing the tRPC client.
 */

import { TELEMETRY_DESCRIPTION_KEY, type TelemetryDescription } from '@/lib/telemetry/error-sink';

/**
 * Message and tRPC-style code for a typed worker failure of the paged read.
 * One source for the preview's error state and the manager's snapshot replay:
 * `retryable_failure` stays retryable, the terminal kinds do not.
 */
export const SESSION_HISTORY_FAILURES = {
  retryable_failure: {
    kind: 'retryable_failure',
    message: 'Session history temporarily unavailable',
    code: 'INTERNAL_SERVER_ERROR',
  },
  too_large: {
    kind: 'too_large',
    message: 'Session history too large to load',
    code: 'UNPROCESSABLE_CONTENT',
  },
  invalid_data: {
    kind: 'invalid_data',
    message: 'Session history is unavailable',
    code: 'UNPROCESSABLE_CONTENT',
  },
} as const;

/** One typed worker failure of the paged transcript read. */
export type SessionHistoryFailureKind = keyof typeof SESSION_HISTORY_FAILURES;

/**
 * The failures a retry cannot recover: the stored page is oversize or
 * unreadable, so the same read answers the same way every time. A retryable
 * failure is absent by design — offering Retry for it is correct.
 */
export const TERMINAL_SESSION_HISTORY_FAILURE_KINDS: readonly SessionHistoryFailureKind[] = [
  'too_large',
  'invalid_data',
];

/** True when the failure kind is one a retry cannot recover. */
export function isTerminalSessionHistoryFailure(kind: SessionHistoryFailureKind): boolean {
  return TERMINAL_SESSION_HISTORY_FAILURE_KINDS.includes(kind);
}

/**
 * The reader copy key for a failure kind, so the terminal state names the
 * failure from its type instead of matching the wire's English message. Only
 * a terminal kind has one; a retryable failure never resolves through it.
 * The English `message` stays the wire identity of the row itself.
 */
export function sessionHistoryFailureCopyKey(
  kind: SessionHistoryFailureKind
): 'agentChat.session.historyTooLarge' | 'agentChat.session.historyUnavailable' {
  return kind === 'too_large'
    ? 'agentChat.session.historyTooLarge'
    : 'agentChat.session.historyUnavailable';
}

/**
 * A typed worker failure, carrying the `code` the query error readers classify
 * on.
 *
 * It also declares its own telemetry, the way the CLI command error does
 * (`lib/hooks/cli-command-unavailable-error.ts`): the app-wide query reporter
 * files it under one stable fingerprint per failure kind instead of the
 * catch-all `app-error` grouping, so the expected transient outage and the two
 * terminal kinds stay distinguishable. A retryable failure is the outage the
 * preview already offers a retry for (warning); a terminal kind names a stored
 * page that cannot be read (error).
 */
export class SessionHistoryFailureError extends Error {
  readonly code: string;
  readonly [TELEMETRY_DESCRIPTION_KEY]: TelemetryDescription;

  constructor(failure: { kind: SessionHistoryFailureKind; message: string; code: string }) {
    super(failure.message);
    this.name = 'SessionHistoryFailureError';
    this.code = failure.code;
    this[TELEMETRY_DESCRIPTION_KEY] = {
      level: failure.kind === 'retryable_failure' ? 'warning' : 'error',
      fingerprint: ['session-history-page', failure.kind],
      tags: { 'error.subsystem': 'session-history', 'error.operation': 'read-page' },
    };
  }
}
