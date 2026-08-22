/**
 * Code Review operation ledger settle (P1-A-07c).
 *
 * The review row is admitted at creation (`createCodeReview`) and settled here
 * once the review reaches a terminal state. `settleCodeReviewLedgerRow` is the
 * best-effort form for sites whose terminalization already committed (the
 * callback); `settleCodeReviewLedgerRowOn` throws so the reaper can roll back
 * its terminalize transaction and retry. A missing admit row skips with a log.
 */
import { and, eq } from 'drizzle-orm';
import { CODE_REVIEW_SETTLED_EVENT } from '@kilocode/app-shared/analytics';
import {
  settleOperation,
  type LedgerDatabase,
  type TerminalOperationStatus,
} from '@kilocode/db/operation-ledger';
import { kilocode_users, operation_ledgers } from '@kilocode/db/schema';
import type { CodeReviewTriggerSource } from '@kilocode/db/schema-types';

import { db } from '@/lib/drizzle';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * The ledger intent for a review's trigger source. `trigger_source` is null
 * for legacy rows, which predate webhook triggers and were always manual.
 */
export function codeReviewLedgerIntent(triggerSource: string | null): CodeReviewTriggerSource {
  return triggerSource === 'webhook' ? 'webhook' : 'manual';
}

/**
 * Maps a review terminal state to a terminal ledger outcome. Non-terminal
 * states map to null, so a settle for a still-running review is a no-op.
 */
export function codeReviewTerminalOutcome(
  status: string,
  terminalReason: string | null
): TerminalOperationStatus | null {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      if (terminalReason === 'superseded') return 'superseded';
      if (terminalReason === 'interrupted') return 'interrupted';
      return 'no_op';
    default:
      return null;
  }
}

/**
 * Settles the admitted `code_review` ledger row using `database` (a pool or an
 * open transaction), emitting exactly one `code_review_settled` outbox event.
 * The settle is a compare-and-set from a non-terminal state, so a second call
 * is a no-op. A missing admit row skips with a log. A settle failure throws so
 * the caller can roll back an enclosing transaction.
 */
export async function settleCodeReviewLedgerRowOn(
  database: LedgerDatabase,
  params: {
    reviewId: string;
    status: string;
    terminalReason: string | null;
    triggerSource: string | null;
  }
): Promise<void> {
  const outcome = codeReviewTerminalOutcome(params.status, params.terminalReason);
  if (!outcome) return;

  const [row] = await database
    .select({
      id: operation_ledgers.id,
      kilo_user_id: operation_ledgers.kilo_user_id,
      admitted_at: operation_ledgers.admitted_at,
      google_user_email: kilocode_users.google_user_email,
    })
    .from(operation_ledgers)
    .leftJoin(kilocode_users, eq(kilocode_users.id, operation_ledgers.kilo_user_id))
    .where(
      and(
        eq(operation_ledgers.domain, 'code_review'),
        eq(operation_ledgers.operation_key, `review:${params.reviewId}`)
      )
    )
    .limit(1);

  if (!row) {
    logExceptInTest('[code-review-ledger] No admitted ledger row to settle', {
      reviewId: params.reviewId,
    });
    return;
  }

  await settleOperation(database, {
    rowId: row.id,
    status: outcome,
    outboxEvent: {
      eventName: CODE_REVIEW_SETTLED_EVENT,
      // The outbox contract documents `distinctId` as the user's email, so
      // resolve it first and fall back to the raw id, matching the sibling
      // PR and security emitters (`google_user_email ?? id`).
      distinctId: row.google_user_email ?? row.kilo_user_id,
      properties: {
        source: 'web',
        surface: 'code_review',
        phase: 'terminal',
        intent: codeReviewLedgerIntent(params.triggerSource),
        outcome,
        duration_ms: Math.max(0, Date.now() - new Date(row.admitted_at).getTime()),
      },
    },
  });
}

/**
 * Settles the admitted `code_review` ledger row for a review, emitting exactly
 * one `code_review_settled` outbox event. The settle is a compare-and-set from
 * a non-terminal state, so a second call is a no-op. A missing admit row skips
 * with a log; a ledger write failure is logged and never thrown.
 */
export async function settleCodeReviewLedgerRow(params: {
  reviewId: string;
  status: string;
  terminalReason: string | null;
  triggerSource: string | null;
}): Promise<void> {
  try {
    await settleCodeReviewLedgerRowOn(db, params);
  } catch (error) {
    logExceptInTest('[code-review-ledger] Failed to settle code review ledger row', {
      reviewId: params.reviewId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
