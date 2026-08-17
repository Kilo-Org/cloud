/**
 * Durable analytics outbox state machine (P2-A-04).
 *
 * Modeled on `user_affiliate_events` + `dispatchQueuedAffiliateEvents`
 * (adapted, not imported). Rows are inserted ONLY by the operation-ledger
 * settle helpers in `operation-ledger.ts`; this module moves rows through the
 * delivery states:
 *
 * - `pending` → (claim) → `sending` → (delivered) → `delivered`
 * - `sending` → (send error) → backoff retry → `pending` with `next_attempt_at`
 * - `pending` → ... after `OUTBOX_MAX_ATTEMPTS` attempts → `failed`
 * - `sending` claims older than `OUTBOX_STALE_SENDING_WINDOW_MS` → reclaimed to `pending`
 *
 * Delivery marks (`markOutboxDelivered`, `markOutboxRetry`, `markOutboxFailed`)
 * are fenced on the claim: each takes the `claimed_at` token returned by the
 * claim and updates only while the row is still that `sending` claim. A late
 * mark from a sender whose claim was reclaimed and re-claimed is a no-op.
 *
 * `purgeExpired` enforces DEC-01 retention (delivered rows after 7 days,
 * failed rows after 30 days) and runs the ledger backstop: non-terminal ledger
 * rows past `expires_at` settle as `failed` with `outcome_code:
 * 'expired_unsettled'` (operational residue, never a user outcome event).
 *
 * Delivery is at-least-once; duplicates are possible only in the crash window
 * between send and mark, deduplicated by PostHog on the deterministic
 * `event_uuid` where supported.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { LedgerDatabase } from './operation-ledger';
import { OPERATION_NON_TERMINAL_STATUSES } from './operation-ledger';
import { analytics_event_outbox, operation_ledgers, type AnalyticsEventOutboxRow } from './schema';

// ----- constants -----------------------------------------------------------

/** A row fails terminally after this many send attempts. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/** A `sending` claim older than this is stale and gets reclaimed. */
export const OUTBOX_STALE_SENDING_WINDOW_MS = 5 * 60 * 1000;

/** Retry backoff constants (same shape as the affiliate event drainer). */
export const OUTBOX_INITIAL_RETRY_BACKOFF_MS = 60 * 1000;
export const OUTBOX_MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;

/** DEC-01 retention windows. */
export const OUTBOX_DELIVERED_RETENTION_DAYS = 7;
export const OUTBOX_FAILED_RETENTION_DAYS = 30;

/** Outcome code written by the cron backstop for expired non-terminal rows. */
export const EXPIRED_UNSETTLED_OUTCOME_CODE = 'expired_unsettled';

// ----- result types -----------------------------------------------------------

export type OutboxRetryResult =
  | { outcome: 'retried'; row: AnalyticsEventOutboxRow }
  | { outcome: 'failed'; row: AnalyticsEventOutboxRow };

export type PurgeExpiredResult = {
  outboxDeliveredPurged: number;
  outboxFailedPurged: number;
  expiredUnsettledLedgerSettled: number;
};

// ----- claim ------------------------------------------------------------------

/**
 * Claims due `pending` rows in a bounded batch: transitions them to `sending`
 * with `claimed_at`, ordered oldest-first, `FOR UPDATE SKIP LOCKED` so
 * concurrent drainers never double-claim. A row is due when
 * `next_attempt_at` is null or in the past.
 */
export async function claimDueOutboxEvents(
  database: LedgerDatabase,
  limit: number
): Promise<AnalyticsEventOutboxRow[]> {
  return database
    .update(analytics_event_outbox)
    .set({
      status: 'sending',
      claimed_at: sql`now()`,
    })
    .where(sql`${analytics_event_outbox.id} IN (
      SELECT ${analytics_event_outbox.id}
      FROM ${analytics_event_outbox}
      WHERE ${analytics_event_outbox.status} = 'pending'
        AND coalesce(${analytics_event_outbox.next_attempt_at}, '-infinity'::timestamptz) <= now()
      ORDER BY ${analytics_event_outbox.created_at} ASC, ${analytics_event_outbox.id} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )`)
    .returning();
}

// ----- terminal marks -----------------------------------------------------------

/**
 * Marks a claimed event delivered. The update is fenced on the claim token
 * `claimedAt`: it only matches while the row is still the `sending` claim
 * identified by that timestamp. A late mark from a sender whose claim was
 * stale-reclaimed and re-claimed, or a replay after delivery, affects zero
 * rows and returns null. Clears the claim and the retry clock; `delivered_at`
 * drives the 7-day purge.
 */
export async function markOutboxDelivered(
  database: LedgerDatabase,
  input: { eventId: string; claimedAt: string }
): Promise<AnalyticsEventOutboxRow | null> {
  const [updated] = await database
    .update(analytics_event_outbox)
    .set({
      status: 'delivered',
      delivered_at: sql`now()`,
      next_attempt_at: null,
      claimed_at: null,
    })
    .where(
      and(
        eq(analytics_event_outbox.id, input.eventId),
        eq(analytics_event_outbox.status, 'sending'),
        eq(analytics_event_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();
  return updated ?? null;
}

/**
 * Marks a claimed event for backoff retry or terminal failure in one atomic,
 * claim-fenced update. The `claimedAt` token in the WHERE clause covers the
 * whole transition: it matches only while the row is still the `sending`
 * claim identified by that timestamp. A stale sender's late retry — after its
 * claim was reclaimed and re-claimed, or after delivery — affects zero rows
 * and returns null instead of requeueing or failing the newer claim.
 *
 * The same statement increments `attempts` and computes the next state: when
 * the new attempt count reaches `OUTBOX_MAX_ATTEMPTS` the event transitions
 * to `failed` with `next_attempt_at` cleared; otherwise it returns to
 * `pending` with the exponential backoff deadline. Because both outcomes
 * commit in one UPDATE, a crash mid-transition cannot orphan the row in a
 * half-updated `sending` claim.
 */
export async function markOutboxRetry(
  database: LedgerDatabase,
  input: { eventId: string; claimedAt: string; error?: string | null }
): Promise<OutboxRetryResult | null> {
  const [row] = await database
    .update(analytics_event_outbox)
    .set({
      attempts: sql`${analytics_event_outbox.attempts} + 1`,
      status: sql`case when ${analytics_event_outbox.attempts} + 1 >= ${OUTBOX_MAX_ATTEMPTS} then 'failed' else 'pending' end`,
      next_attempt_at: sql`case
        when ${analytics_event_outbox.attempts} + 1 >= ${OUTBOX_MAX_ATTEMPTS} then null
        else now() + (least(${OUTBOX_INITIAL_RETRY_BACKOFF_MS} * pow(2.0, ${analytics_event_outbox.attempts}::float8), ${OUTBOX_MAX_RETRY_BACKOFF_MS}) * interval '1 millisecond')
      end`,
      claimed_at: null,
      last_error: input.error ?? null,
    })
    .where(
      and(
        eq(analytics_event_outbox.id, input.eventId),
        eq(analytics_event_outbox.status, 'sending'),
        eq(analytics_event_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();

  if (!row) {
    // The claim is no longer active (reclaimed, delivered, failed, or purged).
    return null;
  }

  return row.attempts >= OUTBOX_MAX_ATTEMPTS
    ? { outcome: 'failed', row }
    : { outcome: 'retried', row };
}

/**
 * Force-marks a claimed event failed (used for definitive, non-retryable send
 * errors). The update is fenced on the claim token `claimedAt`: it only
 * matches while the row is still the `sending` claim identified by that
 * timestamp; a late mark from a stale sender affects zero rows and returns
 * null. Increments `attempts` so the failure is visible in the count.
 */
export async function markOutboxFailed(
  database: LedgerDatabase,
  input: { eventId: string; claimedAt: string; error?: string | null }
): Promise<AnalyticsEventOutboxRow | null> {
  const [updated] = await database
    .update(analytics_event_outbox)
    .set({
      status: 'failed',
      attempts: sql`${analytics_event_outbox.attempts} + 1`,
      next_attempt_at: null,
      claimed_at: null,
      last_error: input.error ?? null,
    })
    .where(
      and(
        eq(analytics_event_outbox.id, input.eventId),
        eq(analytics_event_outbox.status, 'sending'),
        eq(analytics_event_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();
  return updated ?? null;
}

// ----- reclaim -----------------------------------------------------------------

/**
 * Reclaims `sending` rows whose claim is older than
 * `OUTBOX_STALE_SENDING_WINDOW_MS`: they return to `pending` and become due
 * again. Covers the crash window where a drainer died after claiming.
 */
export async function reclaimStaleSendingEvents(
  database: LedgerDatabase
): Promise<AnalyticsEventOutboxRow[]> {
  const staleBefore = new Date(Date.now() - OUTBOX_STALE_SENDING_WINDOW_MS).toISOString();
  return database
    .update(analytics_event_outbox)
    .set({ status: 'pending', claimed_at: null })
    .where(
      and(
        eq(analytics_event_outbox.status, 'sending'),
        sql`${analytics_event_outbox.claimed_at} <= ${staleBefore}::timestamptz`
      )
    )
    .returning();
}

// ----- purge and backstop ---------------------------------------------------------

/**
 * Enforces DEC-01 retention and runs the `expired_unsettled` ledger backstop:
 * - deletes `delivered` outbox rows older than `OUTBOX_DELIVERED_RETENTION_DAYS` (7);
 * - deletes `failed` outbox rows older than `OUTBOX_FAILED_RETENTION_DAYS` (30);
 * - settles non-terminal ledger rows past `expires_at` as `failed` with
 *   `outcome_code: 'expired_unsettled'` and no outbox event.
 */
export async function purgeExpired(database: LedgerDatabase): Promise<PurgeExpiredResult> {
  const delivered = await database
    .delete(analytics_event_outbox)
    .where(
      and(
        eq(analytics_event_outbox.status, 'delivered'),
        sql`${analytics_event_outbox.delivered_at} < now() - make_interval(days => ${OUTBOX_DELIVERED_RETENTION_DAYS})`
      )
    )
    .returning({ id: analytics_event_outbox.id });

  const failed = await database
    .delete(analytics_event_outbox)
    .where(
      and(
        eq(analytics_event_outbox.status, 'failed'),
        sql`${analytics_event_outbox.created_at} < now() - make_interval(days => ${OUTBOX_FAILED_RETENTION_DAYS})`
      )
    )
    .returning({ id: analytics_event_outbox.id });

  const backstop = await database
    .update(operation_ledgers)
    .set({
      status: 'failed',
      outcome_code: EXPIRED_UNSETTLED_OUTCOME_CODE,
      settled_at: sql`now()`,
    })
    .where(
      and(
        inArray(operation_ledgers.status, OPERATION_NON_TERMINAL_STATUSES),
        sql`${operation_ledgers.expires_at} < now()`
      )
    )
    .returning({ id: operation_ledgers.id });

  return {
    outboxDeliveredPurged: delivered.length,
    outboxFailedPurged: failed.length,
    expiredUnsettledLedgerSettled: backstop.length,
  };
}
