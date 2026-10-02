/**
 * Durable outbox state machine for Bouncer financial credit events.
 *
 * Financial callers enqueue a row atomically with the primary write (or at
 * least before they acknowledge the payment/webhook) so a charge step or store
 * money event survives a Bouncer or network outage; the cron drainer in
 * `apps/web/src/lib/bouncer/dispatch-credit-event-outbox.ts` moves rows through
 * the delivery states:
 *
 * - `pending` → (claim) → `sending` → (delivered) → `delivered`
 * - `sending` → (transport failure) → backoff retry → `pending` with `next_attempt_at`
 * - `pending` → ... after `BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS` attempts → `failed`
 * - `sending` claims older than `BOUNCER_CREDIT_EVENT_OUTBOX_STALE_SENDING_WINDOW_MS`
 *   → reclaimed to `pending`
 *
 * Delivery marks (`markBouncerCreditEventDelivered`, `markBouncerCreditEventRetry`,
 * `markBouncerCreditEventFailed`) are fenced on the claim: each takes the
 * `claimed_at` token returned by the claim and updates only while the row is
 * still that `sending` claim. A late mark from a sender whose claim was
 * reclaimed and re-claimed is a no-op.
 *
 * `enqueueBouncerCreditEvent` is idempotent on the unique `event_id`, so a
 * webhook/notification replay enqueues nothing new and a caller can re-enqueue
 * after an already-processed short-circuit without duplicating a side effect.
 *
 * `purgeExpiredBouncerCreditEvents` keeps storage bounded: `delivered` rows are
 * pruned after `..._DELIVERED_RETENTION_DAYS`, `failed` rows after
 * `..._FAILED_RETENTION_DAYS`.
 *
 * This mirrors the conventions of `analytics-outbox.ts` and
 * `external-side-effect-outbox.ts`; it is a dedicated table because those rows
 * are email/analytics-specific.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';

import type * as schema from './schema';
import {
  bouncer_credit_event_outbox,
  type BouncerCreditEventOutboxPayload,
  type BouncerCreditEventOutboxRow,
} from './schema';

// ----- constants -----------------------------------------------------------

/** A row fails terminally after this many delivery attempts. */
export const BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS = 8;

/** A `sending` claim older than this is stale and gets reclaimed. */
export const BOUNCER_CREDIT_EVENT_OUTBOX_STALE_SENDING_WINDOW_MS = 5 * 60 * 1000;

/** Retry backoff constants (same shape as the analytics outbox drainer). */
export const BOUNCER_CREDIT_EVENT_OUTBOX_INITIAL_RETRY_BACKOFF_MS = 60 * 1000;
export const BOUNCER_CREDIT_EVENT_OUTBOX_MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Retention windows for terminal rows, so the table cannot grow without bound. `delivered` is
 * retained for the same 30 days as `failed`: delivered rows are the dedupe fence that suppresses a
 * provider redelivery, and bouncer's own credit ledger dedupes within the same window.
 */
export const BOUNCER_CREDIT_EVENT_OUTBOX_DELIVERED_RETENTION_DAYS = 30;
export const BOUNCER_CREDIT_EVENT_OUTBOX_FAILED_RETENTION_DAYS = 30;

// ----- connection types -----------------------------------------------------

export type BouncerCreditEventOutboxTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Accepts either a `NodePgDatabase` or an open transaction. */
export type BouncerCreditEventOutboxDatabase =
  | NodePgDatabase<typeof schema>
  | BouncerCreditEventOutboxTransaction;

// ----- result types -----------------------------------------------------------

export type EnqueueBouncerCreditEventResult = {
  /** False when the unique `event_id` already had a row (an idempotent replay). */
  enqueued: boolean;
};

export type BouncerCreditEventOutboxRetryResult =
  | { outcome: 'retried'; row: BouncerCreditEventOutboxRow }
  | { outcome: 'failed'; row: BouncerCreditEventOutboxRow };

export type PurgeBouncerCreditEventOutboxResult = {
  deliveredPurged: number;
  failedPurged: number;
};

// ----- enqueue ------------------------------------------------------------------

/**
 * Enqueues one credit event, idempotently on the stable `event_id`. A replay of
 * the same source event (Stripe webhook redelivery, Apple/Google notification
 * redelivery, or a replayed store-purchase completion) inserts nothing and
 * returns `{ enqueued: false }`. Passing a transaction makes the enqueue atomic
 * with the caller's primary write; a DB error propagates so the caller can let
 * the provider retry.
 */
export async function enqueueBouncerCreditEvent(
  database: BouncerCreditEventOutboxDatabase,
  input: {
    eventId: string;
    eventType: string;
    userId: string;
    payload: BouncerCreditEventOutboxPayload;
  }
): Promise<EnqueueBouncerCreditEventResult> {
  const inserted = await database
    .insert(bouncer_credit_event_outbox)
    .values({
      event_id: input.eventId,
      event_type: input.eventType,
      user_id: input.userId,
      payload: input.payload,
    })
    .onConflictDoNothing({
      target: [bouncer_credit_event_outbox.event_id, bouncer_credit_event_outbox.event_type],
    })
    .returning({ id: bouncer_credit_event_outbox.id });
  return { enqueued: inserted.length > 0 };
}

/**
 * Deletes a claimed row, fenced on the claim token `claimedAt` (and `sending` status) exactly like
 * the delivery marks: used by the drainer to drop a claimed row whose owner became gone/deleting
 * after enqueue, so a stale claim never sends a deleted account's PII and never deletes a row a
 * newer claim now owns. Returns false when the claim already transitioned.
 */
export async function deleteBouncerCreditEvent(
  database: BouncerCreditEventOutboxDatabase,
  input: { id: string; claimedAt: string }
): Promise<boolean> {
  const deleted = await database
    .delete(bouncer_credit_event_outbox)
    .where(
      and(
        eq(bouncer_credit_event_outbox.id, input.id),
        eq(bouncer_credit_event_outbox.status, 'sending'),
        eq(bouncer_credit_event_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning({ id: bouncer_credit_event_outbox.id });
  return deleted.length > 0;
}

// ----- claim ------------------------------------------------------------------

/**
 * Claims due `pending` rows in a bounded batch: transitions them to `sending`
 * with `claimed_at`, ordered oldest-first, `FOR UPDATE SKIP LOCKED` so
 * concurrent drainers never double-claim. A row is due when `next_attempt_at`
 * is null or in the past.
 */
export async function claimDueBouncerCreditEvents(
  database: BouncerCreditEventOutboxDatabase,
  limit: number
): Promise<BouncerCreditEventOutboxRow[]> {
  return database
    .update(bouncer_credit_event_outbox)
    .set({
      status: 'sending',
      claimed_at: sql`now()`,
    })
    .where(sql`${bouncer_credit_event_outbox.id} IN (
      SELECT ${bouncer_credit_event_outbox.id}
      FROM ${bouncer_credit_event_outbox}
      WHERE ${bouncer_credit_event_outbox.status} = 'pending'
        AND coalesce(${bouncer_credit_event_outbox.next_attempt_at}, '-infinity'::timestamptz) <= now()
      ORDER BY ${bouncer_credit_event_outbox.created_at} ASC, ${bouncer_credit_event_outbox.id} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )`)
    .returning();
}

// ----- terminal marks -----------------------------------------------------------

/**
 * Marks a claimed row delivered. The update is fenced on the claim token
 * `claimedAt`: it only matches while the row is still the `sending` claim
 * identified by that timestamp. A late mark from a stale sender affects zero
 * rows and returns null.
 */
export async function markBouncerCreditEventDelivered(
  database: BouncerCreditEventOutboxDatabase,
  input: { id: string; claimedAt: string }
): Promise<BouncerCreditEventOutboxRow | null> {
  const [updated] = await database
    .update(bouncer_credit_event_outbox)
    .set({
      status: 'delivered',
      delivered_at: sql`now()`,
      next_attempt_at: null,
      claimed_at: null,
    })
    .where(
      and(
        eq(bouncer_credit_event_outbox.id, input.id),
        eq(bouncer_credit_event_outbox.status, 'sending'),
        eq(bouncer_credit_event_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();
  return updated ?? null;
}

/**
 * Marks a claimed row for backoff retry or terminal failure in one atomic,
 * claim-fenced update. When the new attempt count reaches
 * `BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS` the row transitions to `failed`
 * with `next_attempt_at` cleared; otherwise it returns to `pending` with the
 * exponential backoff deadline.
 */
export async function markBouncerCreditEventRetry(
  database: BouncerCreditEventOutboxDatabase,
  input: { id: string; claimedAt: string; error?: string | null }
): Promise<BouncerCreditEventOutboxRetryResult | null> {
  const [row] = await database
    .update(bouncer_credit_event_outbox)
    .set({
      attempts: sql`${bouncer_credit_event_outbox.attempts} + 1`,
      status: sql`case when ${bouncer_credit_event_outbox.attempts} + 1 >= ${BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS} then 'failed' else 'pending' end`,
      next_attempt_at: sql`case
        when ${bouncer_credit_event_outbox.attempts} + 1 >= ${BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS} then null
        else now() + (least(${BOUNCER_CREDIT_EVENT_OUTBOX_INITIAL_RETRY_BACKOFF_MS} * pow(2.0, ${bouncer_credit_event_outbox.attempts}::float8), ${BOUNCER_CREDIT_EVENT_OUTBOX_MAX_RETRY_BACKOFF_MS}) * interval '1 millisecond')
      end`,
      claimed_at: null,
      last_error: input.error ?? null,
    })
    .where(
      and(
        eq(bouncer_credit_event_outbox.id, input.id),
        eq(bouncer_credit_event_outbox.status, 'sending'),
        eq(bouncer_credit_event_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();

  if (!row) {
    // The claim is no longer active (reclaimed, delivered, failed, or purged).
    return null;
  }

  return row.attempts >= BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS
    ? { outcome: 'failed', row }
    : { outcome: 'retried', row };
}

/**
 * Force-marks a claimed row failed for a definitive, non-retryable outcome
 * (for example Bouncer is not configured in this environment). Fenced on the
 * claim token `claimedAt`; a late mark from a stale sender affects zero rows
 * and returns null.
 */
export async function markBouncerCreditEventFailed(
  database: BouncerCreditEventOutboxDatabase,
  input: { id: string; claimedAt: string; error?: string | null }
): Promise<BouncerCreditEventOutboxRow | null> {
  const [updated] = await database
    .update(bouncer_credit_event_outbox)
    .set({
      status: 'failed',
      attempts: sql`${bouncer_credit_event_outbox.attempts} + 1`,
      next_attempt_at: null,
      claimed_at: null,
      last_error: input.error ?? null,
    })
    .where(
      and(
        eq(bouncer_credit_event_outbox.id, input.id),
        eq(bouncer_credit_event_outbox.status, 'sending'),
        eq(bouncer_credit_event_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();
  return updated ?? null;
}

// ----- reclaim -----------------------------------------------------------------

/**
 * Reclaims `sending` rows whose claim is older than
 * `BOUNCER_CREDIT_EVENT_OUTBOX_STALE_SENDING_WINDOW_MS`: they return to
 * `pending` and become due again. Covers the crash window where a drainer died
 * after claiming.
 */
export async function reclaimStaleBouncerCreditEvents(
  database: BouncerCreditEventOutboxDatabase,
  limit: number
): Promise<BouncerCreditEventOutboxRow[]> {
  const staleBefore = new Date(
    Date.now() - BOUNCER_CREDIT_EVENT_OUTBOX_STALE_SENDING_WINDOW_MS
  ).toISOString();
  return database
    .update(bouncer_credit_event_outbox)
    .set({ status: 'pending', claimed_at: null })
    .where(sql`${bouncer_credit_event_outbox.id} IN (
      SELECT ${bouncer_credit_event_outbox.id}
      FROM ${bouncer_credit_event_outbox}
      WHERE ${bouncer_credit_event_outbox.status} = 'sending'
        AND ${bouncer_credit_event_outbox.claimed_at} <= ${staleBefore}::timestamptz
      ORDER BY ${bouncer_credit_event_outbox.claimed_at} ASC, ${bouncer_credit_event_outbox.id} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )`)
    .returning();
}

// ----- purge and retention -------------------------------------------------------

/**
 * Deletes terminal rows past their retention window, so the outbox cannot grow
 * without bound. Runs on the same cron pass as the drain.
 */
export async function purgeExpiredBouncerCreditEvents(
  database: BouncerCreditEventOutboxDatabase,
  limit: number
): Promise<PurgeBouncerCreditEventOutboxResult> {
  const delivered = await database
    .delete(bouncer_credit_event_outbox)
    .where(sql`${bouncer_credit_event_outbox.id} IN (
      SELECT ${bouncer_credit_event_outbox.id}
      FROM ${bouncer_credit_event_outbox}
      WHERE ${bouncer_credit_event_outbox.status} = 'delivered'
        AND ${bouncer_credit_event_outbox.delivered_at} < now() - make_interval(days => ${BOUNCER_CREDIT_EVENT_OUTBOX_DELIVERED_RETENTION_DAYS})
      ORDER BY ${bouncer_credit_event_outbox.delivered_at} ASC
      LIMIT ${limit}
    )`)
    .returning({ id: bouncer_credit_event_outbox.id });

  const failed = await database
    .delete(bouncer_credit_event_outbox)
    .where(sql`${bouncer_credit_event_outbox.id} IN (
      SELECT ${bouncer_credit_event_outbox.id}
      FROM ${bouncer_credit_event_outbox}
      WHERE ${bouncer_credit_event_outbox.status} = 'failed'
        AND ${bouncer_credit_event_outbox.created_at} < now() - make_interval(days => ${BOUNCER_CREDIT_EVENT_OUTBOX_FAILED_RETENTION_DAYS})
      ORDER BY ${bouncer_credit_event_outbox.created_at} ASC
      LIMIT ${limit}
    )`)
    .returning({ id: bouncer_credit_event_outbox.id });

  return { deliveredPurged: delivered.length, failedPurged: failed.length };
}
