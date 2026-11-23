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
 * The reader copy key for each kind a retry cannot recover, keyed by the kind
 * so a kind added later fails the type check here instead of borrowing the
 * unreadable-data line.
 */
const TERMINAL_HISTORY_COPY_KEY = {
  too_large: 'agentChat.session.historyTooLarge',
  invalid_data: 'agentChat.session.historyUnavailable',
} as const;

/** A kind a retry cannot recover. */
type TerminalSessionHistoryFailureKind = keyof typeof TERMINAL_HISTORY_COPY_KEY;

/**
 * The reader copy key for a failure kind, so the terminal state names the
 * failure from its type instead of matching the wire's English message. The
 * English `message` stays the wire identity of the row itself.
 */
function sessionHistoryFailureCopyKey(
  kind: TerminalSessionHistoryFailureKind
): (typeof TERMINAL_HISTORY_COPY_KEY)[TerminalSessionHistoryFailureKind] {
  return TERMINAL_HISTORY_COPY_KEY[kind];
}

/**
 * The reader's copy and retryability for a typed transcript-read failure. The
 * retryable kind names this app's own temporary outage and keeps its Retry;
 * a terminal kind names a stored page a retry re-reads unchanged. The raw
 * string stays in `detail` for Copy.
 */
export function sessionHistoryFailureCopy(kind: SessionHistoryFailureKind): {
  copyKey: string;
  retryable: boolean;
} {
  return kind === 'retryable_failure'
    ? { copyKey: 'agentChat.session.historyTemporarilyUnavailable', retryable: true }
    : { copyKey: sessionHistoryFailureCopyKey(kind), retryable: false };
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
