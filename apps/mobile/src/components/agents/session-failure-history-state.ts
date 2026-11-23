import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { z } from 'zod';

import { formatDate, UNMEASURED_VALUE } from '@/lib/format';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { parseTimestamp } from '@/lib/utils';

/** The failure-history answer, in the shape the router declares it. */
type SessionFailureHistory =
  inferRouterOutputs<MobileRouter>['cloudAgentNextFailures']['getSessionFailureHistory'];
export type SessionFailureRun = SessionFailureHistory['runs'][number];
export type SessionSetupFailure = NonNullable<SessionFailureHistory['setupFailure']>;

/**
 * The ids the failure-history procedure answers for: a control-plane session is
 * `agent_…`, a stored session's workspace is `workspace_…`. Every other id
 * (a local-only session, an empty string) has no diagnostics to read, so the
 * section neither renders nor queries for it. The pattern carries no `g` flag,
 * so it holds no `lastIndex` between calls.
 */
const ADDRESSABLE_SESSION_ID = /^(agent|workspace)_/;

/** Whether the control plane can answer a failure history for this id. */
export function isAddressableSessionId(id: string | null): id is string {
  return id !== null && ADDRESSABLE_SESSION_ID.test(id);
}

/**
 * The codes a retry cannot change: the reader is not a member of the session
 * (`FORBIDDEN`, `NOT_FOUND`) or the token no longer names them (`UNAUTHORIZED`).
 * Asking again answers the same refusal, so the section states it once instead
 * of retrying behind a spinner.
 */
const TERMINAL_ACCESS_CODES = ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'] as const;

/** True when the failure is an access refusal that a retry cannot recover. */
export function isTerminalAccessError(error: unknown): boolean {
  const code = readTrpcErrorField(error, 'code');
  return TERMINAL_ACCESS_CODES.some(terminal => terminal === code);
}

/*
 * The HTTP status a tRPC answer carried. `readTrpcErrorField` covers the code
 * and the message; the status sits beside them, on `data` for a client error and
 * on `shape.data` for a server-shaped one.
 */
const StatusOnData = z.looseObject({ httpStatus: z.number().optional() });
const DirectStatus = z.looseObject({ data: StatusOnData });
const ShapedStatus = z.looseObject({ shape: z.looseObject({ data: StatusOnData }) });

function httpStatusOf(error: unknown): number | undefined {
  const direct = DirectStatus.safeParse(error);
  if (direct.success && direct.data.data.httpStatus !== undefined) {
    return direct.data.data.httpStatus;
  }
  const shaped = ShapedStatus.safeParse(error);
  return shaped.success ? shaped.data.shape.data.httpStatus : undefined;
}

/**
 * The read's retry policy. An access refusal is final; anything else retries
 * twice, but only when the answer proved the server is unhealthy (5xx) or never
 * reached it (no status at all) — a 4xx that is not an access code repeats the
 * same verdict, so it is final too.
 */
export function shouldRetryFailureHistory(failureCount: number, error: unknown): boolean {
  if (isTerminalAccessError(error)) {
    return false;
  }
  if (failureCount >= 2) {
    return false;
  }
  const status = httpStatusOf(error);
  return status === undefined || status >= 500;
}

/** Whether the history has anything to show: the web's own early return. */
export function hasReportedFailures(history: SessionFailureHistory): boolean {
  return history.setupFailure !== null || history.runs.some(run => run.status === 'failed');
}

/** The runs that failed, in the order the router returned them. */
export function failedRuns(history: SessionFailureHistory): SessionFailureRun[] {
  return history.runs.filter(run => run.status === 'failed');
}

/** The two counts the summary line reads. */
type FailureHistoryCounts = { readonly failed: number; readonly completed: number };

/** Counts the runs the summary line names: failed, and completed. */
export function failureHistoryCounts(history: SessionFailureHistory): FailureHistoryCounts {
  let failed = 0;
  let completed = 0;
  for (const run of history.runs) {
    if (run.status === 'failed') {
      failed += 1;
    } else if (run.status === 'completed') {
      completed += 1;
    }
  }
  return { failed, completed };
}

/**
 * The retained diagnostic line for a failure row, or `undefined` when there is
 * none to show. The router reports a diagnostic as `present` only while it is
 * still inside its retention window, so a `present` row with no text is the one
 * case a caption must still skip rather than paint an empty line.
 */
export function retainedDiagnostic(failure: {
  diagnostic: string | null;
  diagnosticStatus: 'present' | 'expired' | 'missing';
}): string | undefined {
  return failure.diagnosticStatus === 'present' && failure.diagnostic !== null
    ? failure.diagnostic
    : undefined;
}

/**
 * A stored instant as a row's value, in the reader's own date-and-time style.
 * The column reports an unreadable stamp as the unmeasured dash instead of
 * painting an invalid date or dropping the value that belongs there.
 */
export function failureMomentLabel(value: string | null, locale: string): string {
  const moment = parseTimestamp(value);
  return Number.isNaN(moment.getTime())
    ? UNMEASURED_VALUE
    : formatDate(moment, locale, { dateStyle: 'medium', timeStyle: 'short' });
}
