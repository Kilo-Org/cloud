/**
 * Delivery for the durable Bouncer usage-event outbox.
 *
 * `deliverBouncerUsageEventNow` is the gateway's immediate attempt right after the usage write that
 * enqueued the row; `dispatchQueuedBouncerUsageEvents` is the cron pass that retries everything
 * else (reclaim stale claims, claim due rows in bounded batches, deliver, mark, purge). Both claim
 * through `@kilocode/db/bouncer-usage-event-outbox`, so the immediate attempt and the drainer never
 * send the same claim, and a row is marked delivered only on a real 2xx. This mirrors
 * `apps/web/src/lib/bouncer/dispatch-credit-event-outbox.ts`; it lives in web-shared because the
 * gateway's usage path needs the immediate delivery.
 */
import 'server-only';

import { eq } from 'drizzle-orm';
import * as z from 'zod';

import { db } from '@kilocode/web-shared/lib/drizzle';
import { deliverUsageEventWireBody } from '@kilocode/web-shared/lib/bouncer/client';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import {
  bouncerUsageEventExists,
  claimBouncerUsageEventByRequestId,
  claimDueBouncerUsageEvents,
  deleteBouncerUsageEvent,
  markBouncerUsageEventDelivered,
  markBouncerUsageEventFailed,
  markBouncerUsageEventRetry,
  purgeExpiredBouncerUsageEvents,
  reclaimStaleBouncerUsageEvents,
} from '@kilocode/db/bouncer-usage-event-outbox';
import { kilocode_users, type BouncerUsageEventOutboxRow } from '@kilocode/db/schema';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete-reasons';

const logWarning = sentryLogger('bouncer-usage-event-outbox', 'warning');
const logError = sentryLogger('bouncer-usage-event-outbox', 'error');

/** Total rows one pass may claim; also bounds the reclaim and purge batches. */
const DEFAULT_CLAIM_LIMIT = 200;
/** Rows claimed per batch, so a pass that hits its budget strands at most one batch. */
const CLAIM_BATCH_SIZE = 10;
/** Wall-clock budget for one pass; each delivery has its own 5s timeout. */
const DEFAULT_BUDGET_MS = 45_000;

/**
 * Persisted JSON is untrusted at the dispatch boundary (an older deploy may have written it). Check
 * the essentials (the dedupe id and the payer or anonymous key) and forward every field untouched;
 * bouncer validates the rest.
 */
const usageEventBodySchema = z
  .object({ requestId: z.string().min(1) })
  .passthrough()
  .refine(body => typeof body.accountId === 'string' || body.tier === 'anonymous');

export type BouncerUsageEventOutboxDispatchSummary = {
  reclaimed: number;
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
  deliveredPurged: number;
  failedPurged: number;
};

type DispatchOutcome = 'delivered' | 'retried' | 'failed';
type DispatchSource = 'immediate' | 'cron';

/**
 * Claims and delivers the row the usage write just enqueued for `requestId`. Never throws.
 * Resolves true when the outbox holds the event (delivered now, or left for the cron drainer), and
 * false when no row exists or the lookup failed, so the caller falls back to the best-effort send.
 */
export async function deliverBouncerUsageEventNow(requestId: string): Promise<boolean> {
  let row: BouncerUsageEventOutboxRow | null;
  try {
    row = await claimBouncerUsageEventByRequestId(db, requestId);
    // Unclaimable: the drainer holds it, it is terminal, or it was never written.
    if (!row) return await bouncerUsageEventExists(db, requestId);
  } catch (error) {
    logError('Bouncer usage-event outbox claim failed', {
      request_id: requestId,
      error: error instanceof Error ? error.name : String(error),
    });
    return false;
  }
  try {
    await dispatchUsageEvent(row, 'immediate');
  } catch (error) {
    // The row stays claimed and the stale-claim window hands it back to the drainer.
    logError('Immediate bouncer usage-event delivery failed; the cron drainer retries it', {
      request_id: requestId,
      error: error instanceof Error ? error.name : String(error),
    });
  }
  return true;
}

/** Drains the usage-event outbox in one cron pass and returns a per-step summary. */
export async function dispatchQueuedBouncerUsageEvents(params?: {
  limit?: number;
  budgetMs?: number;
}): Promise<BouncerUsageEventOutboxDispatchSummary> {
  const limit = params?.limit ?? DEFAULT_CLAIM_LIMIT;
  const budgetMs = params?.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();

  const reclaimed = await reclaimStaleBouncerUsageEvents(db, limit);
  for (const row of reclaimed) {
    logWarning('Reclaimed stale bouncer usage-event outbox claim', outboxLogFields(row, 'cron'));
  }

  const counts: Record<DispatchOutcome, number> = { delivered: 0, retried: 0, failed: 0 };
  let claimedTotal = 0;
  let remaining = limit;
  while (remaining > 0 && Date.now() - startedAt < budgetMs) {
    const claimed = await claimDueBouncerUsageEvents(db, Math.min(remaining, CLAIM_BATCH_SIZE));
    if (claimed.length === 0) break;
    claimedTotal += claimed.length;
    remaining -= claimed.length;
    for (const row of claimed) {
      if (Date.now() - startedAt >= budgetMs) {
        logWarning('Bouncer usage-event outbox pass hit its budget', outboxLogFields(row, 'cron'));
        break;
      }
      counts[await dispatchUsageEvent(row, 'cron')] += 1;
    }
  }

  const purge = await purgeExpiredBouncerUsageEvents(db, limit);
  return { reclaimed: reclaimed.length, claimed: claimedTotal, ...counts, ...purge };
}

/** Delivers one claimed row and drives its claim-fenced mark. */
async function dispatchUsageEvent(
  row: BouncerUsageEventOutboxRow,
  source: DispatchSource
): Promise<DispatchOutcome> {
  const claimedAt = row.claimed_at;
  if (!claimedAt) {
    // Unreachable through the claim functions, which always stamp the claim.
    logError('Bouncer usage-event outbox row claimed without a claim token', {
      ...outboxLogFields(row, source),
    });
    return 'failed';
  }

  // A soft delete after enqueue must not send the deleted account's PII.
  const [owner] = await db
    .select({ blockedReason: kilocode_users.blocked_reason })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, row.user_id))
    .limit(1);
  if (owner && isGoneOrDeletingBlockedReason(owner.blockedReason)) {
    logWarning(
      'Dropping bouncer usage event for a soft-deleted user',
      outboxLogFields(row, source)
    );
    await deleteBouncerUsageEvent(db, { id: row.id, claimedAt });
    return 'failed';
  }

  const parsed = usageEventBodySchema.safeParse(row.payload);
  if (!parsed.success) {
    logError('Bouncer usage-event outbox row has an invalid payload', outboxLogFields(row, source));
    const failed = await markBouncerUsageEventFailed(db, {
      id: row.id,
      claimedAt,
      error: 'invalid_payload',
    });
    return failed ? 'failed' : 'retried';
  }

  const result = await deliverUsageEventWireBody(parsed.data);
  if (result.delivered) {
    await markBouncerUsageEventDelivered(db, { id: row.id, claimedAt });
    return 'delivered';
  }

  const error = result.status === null ? result.error : `${result.error} (status ${result.status})`;
  if (result.permanent) {
    logError('Bouncer usage-event delivery permanently failed', {
      ...outboxLogFields(row, source),
      error,
    });
    const failed = await markBouncerUsageEventFailed(db, { id: row.id, claimedAt, error });
    return failed ? 'failed' : 'retried';
  }

  logWarning('Bouncer usage-event delivery failed', { ...outboxLogFields(row, source), error });
  const retry = await markBouncerUsageEventRetry(db, { id: row.id, claimedAt, error });
  return retry?.outcome === 'failed' ? 'failed' : 'retried';
}

function outboxLogFields(
  row: BouncerUsageEventOutboxRow,
  source: DispatchSource
): Record<string, unknown> {
  return {
    outbox_id: row.id,
    request_id: row.request_id,
    status: row.status,
    attempts: row.attempts,
    dispatch_source: source,
  };
}
