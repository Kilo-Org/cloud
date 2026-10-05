/**
 * Cron drainer for the durable Bouncer credit-event outbox.
 *
 * One pass: reclaim stale claims, claim due rows in bounded batches, validate each persisted JSON
 * body, deliver it over HTTP, and mark delivered/retry/fail; then purge terminal rows past
 * retention. The row transitions live in `@kilocode/db/bouncer-credit-event-outbox`; this module
 * orchestrates them and delivers via `deliverCreditEventWireBody`, which returns the real HTTP
 * outcome. A row is marked delivered only on a real success, so a transport error can never be
 * recorded as delivered. A permanent result (for example bouncer is not configured) fails the row
 * immediately; anything else backs off and retries up to the attempt cap before failing visibly.
 *
 * The pass is bounded so it always fits a serverless invocation: at most `limit` rows are claimed
 * and the loop stops once `budgetMs` has elapsed. Rows claimed but not finished are left `sending`
 * and are reclaimed by the stale-claim window on the next pass.
 */
import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { deliverCreditEventWireBody } from '@/lib/bouncer/client';
import { parseBouncerCreditEventBody } from '@/lib/bouncer/credit-event-schema';
import { sentryLogger } from '@/lib/utils.server';
import {
  claimDueBouncerCreditEvents,
  deleteBouncerCreditEvent,
  markBouncerCreditEventDelivered,
  markBouncerCreditEventFailed,
  markBouncerCreditEventRetry,
  purgeExpiredBouncerCreditEvents,
  reclaimStaleBouncerCreditEvents,
} from '@kilocode/db/bouncer-credit-event-outbox';
import { kilocode_users, type BouncerCreditEventOutboxRow } from '@kilocode/db/schema';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete-reasons';

const logInfo = sentryLogger('bouncer-credit-event-outbox', 'info');
const logWarning = sentryLogger('bouncer-credit-event-outbox', 'warning');
const logError = sentryLogger('bouncer-credit-event-outbox', 'error');

/** Total rows one pass may claim; also bounds the reclaim and purge batches. */
const DEFAULT_CLAIM_LIMIT = 100;
/** Rows claimed per batch, so a pass that hits its budget strands at most one batch. */
const CLAIM_BATCH_SIZE = 10;
/** Wall-clock budget for one pass; each delivery has its own 5s timeout. */
const DEFAULT_BUDGET_MS = 45_000;

export type BouncerCreditEventOutboxDispatchSummary = {
  reclaimed: number;
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  deliveredPurged: number;
  failedPurged: number;
};

type OutboxDispatchOutcome = 'delivered' | 'retried' | 'failed';

/**
 * Drains the Bouncer credit-event outbox in one cron pass and returns a per-step summary for the
 * cron route. `limit` bounds the rows handled in this pass; `budgetMs` bounds its wall time.
 */
export async function dispatchQueuedBouncerCreditEvents(params?: {
  limit?: number;
  budgetMs?: number;
}): Promise<BouncerCreditEventOutboxDispatchSummary> {
  const limit = params?.limit ?? DEFAULT_CLAIM_LIMIT;
  const budgetMs = params?.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();

  // Reclaim `sending` claims left behind by crashed drainers.
  const reclaimed = await reclaimStaleBouncerCreditEvents(db, limit);
  for (const row of reclaimed) {
    logWarning('Reclaimed stale bouncer credit-event outbox claim', outboxLogFields(row));
  }

  // Claim due `pending` rows in bounded batches and deliver each.
  const counts: Record<OutboxDispatchOutcome, number> = { delivered: 0, retried: 0, failed: 0 };
  let claimedTotal = 0;
  let remaining = limit;
  while (remaining > 0 && Date.now() - startedAt < budgetMs) {
    const claimed = await claimDueBouncerCreditEvents(db, Math.min(remaining, CLAIM_BATCH_SIZE));
    if (claimed.length === 0) {
      break;
    }
    claimedTotal += claimed.length;
    remaining -= claimed.length;
    for (const row of claimed) {
      if (Date.now() - startedAt >= budgetMs) {
        logWarning('Bouncer credit-event outbox pass hit its budget', outboxLogFields(row));
        break;
      }
      counts[await dispatchCreditEvent(row)] += 1;
    }
  }

  const purge = await purgeExpiredBouncerCreditEvents(db, limit);

  return { reclaimed: reclaimed.length, claimed: claimedTotal, ...counts, ...purge };
}

/**
 * Delivers one claimed credit event and drives its delivery mark. Marks are claim-fenced on
 * `claimed_at`, so a late mark from a reclaimed claim is a no-op that leaves the row to the newer
 * claim.
 */
async function dispatchCreditEvent(
  row: BouncerCreditEventOutboxRow
): Promise<OutboxDispatchOutcome> {
  const claimedAt = row.claimed_at;
  if (!claimedAt) {
    // Unreachable through `claimDueBouncerCreditEvents`, which always stamps the claim.
    logError('Bouncer credit-event outbox row claimed without a claim token', outboxLogFields(row));
    return 'failed';
  }

  // A soft delete after enqueue must not send the deleted account's PII: recheck the owner here and
  // drop the claim instead. This only prevents a send that has not happened; a delivery already
  // made before the deletion cannot be undone. The delete is fenced on this claim, so it never
  // removes a row a newer claim owns.
  const [owner] = await db
    .select({ blockedReason: kilocode_users.blocked_reason })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, row.user_id))
    .limit(1);
  if (owner && isGoneOrDeletingBlockedReason(owner.blockedReason)) {
    logWarning('Dropping bouncer credit event for a soft-deleted user', outboxLogFields(row));
    await deleteBouncerCreditEvent(db, { id: row.id, claimedAt });
    return 'failed';
  }

  // Persisted JSON is untrusted at this boundary; fail a malformed row visibly, never silently.
  const body = parseBouncerCreditEventBody(row.payload);
  if (!body) {
    logError('Bouncer credit-event outbox row has an invalid payload', outboxLogFields(row));
    const failed = await markBouncerCreditEventFailed(db, {
      id: row.id,
      claimedAt,
      error: 'invalid_payload',
    });
    return failed ? 'failed' : 'retried';
  }

  const result = await deliverCreditEventWireBody(body);

  if (result.delivered) {
    const delivered = await markBouncerCreditEventDelivered(db, { id: row.id, claimedAt });
    if (!delivered) {
      // The claim was reclaimed and re-claimed mid-flight; the newer claim owns the row now.
      logWarning(
        'Bouncer credit-event delivery mark skipped: claim already transitioned',
        outboxLogFields(row)
      );
      return 'delivered';
    }
    logInfo('Delivered bouncer credit event', outboxLogFields(delivered));
    return 'delivered';
  }

  const error = result.status === null ? result.error : `${result.error} (status ${result.status})`;
  if (result.permanent) {
    logError('Bouncer credit-event delivery permanently failed', {
      ...outboxLogFields(row),
      error,
    });
    const failed = await markBouncerCreditEventFailed(db, { id: row.id, claimedAt, error });
    return failed ? 'failed' : 'retried';
  }

  logError('Bouncer credit-event delivery failed', { ...outboxLogFields(row), error });
  const retry = await markBouncerCreditEventRetry(db, { id: row.id, claimedAt, error });
  return retry?.outcome === 'failed' ? 'failed' : 'retried';
}

function outboxLogFields(row: BouncerCreditEventOutboxRow): Record<string, unknown> {
  return {
    outbox_id: row.id,
    event_id: row.event_id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    dispatch_source: 'cron',
  };
}
