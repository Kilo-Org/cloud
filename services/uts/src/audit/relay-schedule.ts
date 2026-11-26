import { IdentityStoreError } from '../db/client';
import { AuditRowTooLargeError, WatermarkMovedError, type RelayRunResult } from './relay';

/** A run that found nothing, or sent everything it found, runs again after this (design 8.1). */
export const RELAY_INTERVAL_MS = 5_000;
/** After a retryable failure: 5 s doubling per failed run, capped here. */
export const RELAY_MAX_BACKOFF_MS = 60_000;

/**
 * What a run's failure means for the next run.
 * * `retryable`: the database, the connection or the queue failed; back off and try again.
 * * `superseded`: another runner moved the shard's watermark; nothing failed, so the next run
 *   comes at the usual interval and the failure count stays as it was.
 * * `permanent`: the database refused the statement or a row cannot be sent; retrying soon cannot
 *   help, so the next run waits the longest backoff, and the failure log line pages.
 */
export type RelayFailure =
  | { kind: 'retryable'; reason: string }
  | { kind: 'superseded' }
  | { kind: 'permanent'; reason: string };

export function classifyRelayFailure(error: unknown): RelayFailure {
  if (error instanceof WatermarkMovedError) return { kind: 'superseded' };
  if (error instanceof AuditRowTooLargeError) return { kind: 'permanent', reason: error.name };
  if (error instanceof IdentityStoreError) {
    const reason = error.message;
    return error.failure === 'retryable'
      ? { kind: 'retryable', reason }
      : { kind: 'permanent', reason };
  }
  // A queue send that threw: the queue may or may not hold the message, and a resend is deduped.
  return { kind: 'retryable', reason: error instanceof Error ? error.name : 'unknown' };
}

export type RelayRunOutcome =
  | { kind: 'ran'; result: RelayRunResult }
  | { kind: 'failed'; failure: RelayFailure };

/** When the next run starts, and the count of failed runs in a row after this one. */
export type NextRelayRun = { delayMs: number; failedRuns: number };

export function nextRelayRun(outcome: RelayRunOutcome, failedBefore: number): NextRelayRun {
  if (outcome.kind === 'ran') {
    return { delayMs: outcome.result.status === 'more' ? 0 : RELAY_INTERVAL_MS, failedRuns: 0 };
  }
  switch (outcome.failure.kind) {
    case 'superseded':
      return { delayMs: RELAY_INTERVAL_MS, failedRuns: failedBefore };
    case 'permanent':
      return { delayMs: RELAY_MAX_BACKOFF_MS, failedRuns: failedBefore + 1 };
    case 'retryable': {
      const failedRuns = failedBefore + 1;
      return {
        delayMs: Math.min(
          RELAY_INTERVAL_MS * 2 ** Math.min(failedRuns - 1, 16),
          RELAY_MAX_BACKOFF_MS
        ),
        failedRuns,
      };
    }
  }
}
