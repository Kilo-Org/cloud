/**
 * Durable outbox state machine for Bouncer usage events of spend-watched requests.
 *
 * The AI-gateway usage write enqueues a row in the same transaction as the `microdollar_usage`
 * insert when the request's decide verdict said `spendWatch`. The gateway then claims that one row
 * and tries an immediate delivery; the cron drainer in
 * `packages/web-shared/src/lib/bouncer/dispatch-usage-event-outbox.ts` retries the rest:
 *
 * - `pending` → (claim) → `sending` → (delivered) → `delivered`
 * - `sending` → (transport failure) → backoff retry → `pending` with `next_attempt_at`
 * - `pending` → ... after `BOUNCER_USAGE_EVENT_OUTBOX_MAX_ATTEMPTS` attempts → `failed`
 * - `sending` claims older than `BOUNCER_USAGE_EVENT_OUTBOX_STALE_SENDING_WINDOW_MS`
 *   → reclaimed to `pending`
 *
 * Delivery marks are fenced on the claim exactly like `bouncer-credit-event-outbox.ts`: each takes
 * the `claimed_at` token returned by the claim and updates only while the row is still that
 * `sending` claim, so a late mark from a reclaimed sender is a no-op.
 *
 * `enqueueBouncerUsageEvent` is idempotent on the unique `request_id`; Bouncer also dedupes a usage
 * event by `requestId`, so a redelivery after a lost acknowledgement counts once.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { BouncerCreditEventOutboxDatabase } from './bouncer-credit-event-outbox';
import {
  bouncer_usage_event_outbox,
  type BouncerUsageEventOutboxPayload,
  type BouncerUsageEventOutboxRow,
} from './schema';

// ----- constants -----------------------------------------------------------

/** A row fails terminally after this many delivery attempts. */
export const BOUNCER_USAGE_EVENT_OUTBOX_MAX_ATTEMPTS = 8;

/** A `sending` claim older than this is stale and gets reclaimed. */
export const BOUNCER_USAGE_EVENT_OUTBOX_STALE_SENDING_WINDOW_MS = 5 * 60 * 1000;

/**
 * Retry backoff. A spend bucket is debited by these events, so retries stay closer together than
 * the credit outbox's: 30s doubling, capped at 10 minutes.
 */
export const BOUNCER_USAGE_EVENT_OUTBOX_INITIAL_RETRY_BACKOFF_MS = 30 * 1000;
export const BOUNCER_USAGE_EVENT_OUTBOX_MAX_RETRY_BACKOFF_MS = 10 * 60 * 1000;

/**
 * Retention windows for terminal rows. Bouncer dedupes on `requestId`, so a delivered row is not a
 * dedupe fence here and is pruned after a day; a failed row stays a week for investigation.
 */
export const BOUNCER_USAGE_EVENT_OUTBOX_DELIVERED_RETENTION_DAYS = 1;
export const BOUNCER_USAGE_EVENT_OUTBOX_FAILED_RETENTION_DAYS = 7;

// ----- connection types -----------------------------------------------------

/** Accepts either a `NodePgDatabase` or an open transaction. */
export type BouncerUsageEventOutboxDatabase = BouncerCreditEventOutboxDatabase;

// ----- result types -----------------------------------------------------------

export type BouncerUsageEventOutboxRetryResult =
  | { outcome: 'retried'; row: BouncerUsageEventOutboxRow }
  | { outcome: 'failed'; row: BouncerUsageEventOutboxRow };

export type PurgeBouncerUsageEventOutboxResult = {
  deliveredPurged: number;
  failedPurged: number;
};

// ----- enqueue ------------------------------------------------------------------

/**
 * Enqueues one usage event, idempotently on `request_id`. Passing the usage-write transaction makes
 * the enqueue atomic with the billing row; a DB error propagates and rolls both back.
 */
export async function enqueueBouncerUsageEvent(
  database: BouncerUsageEventOutboxDatabase,
  input: { requestId: string; userId: string; payload: BouncerUsageEventOutboxPayload }
): Promise<void> {
  await database
    .insert(bouncer_usage_event_outbox)
    .values({ request_id: input.requestId, user_id: input.userId, payload: input.payload })
    .onConflictDoNothing({ target: bouncer_usage_event_outbox.request_id });
}

// ----- claim ------------------------------------------------------------------

/**
 * Claims due `pending` rows in a bounded batch, oldest first, `FOR UPDATE SKIP LOCKED` so
 * concurrent drainers never double-claim. A row is due when `next_attempt_at` is null or past.
 */
export async function claimDueBouncerUsageEvents(
  database: BouncerUsageEventOutboxDatabase,
  limit: number
): Promise<BouncerUsageEventOutboxRow[]> {
  return database
    .update(bouncer_usage_event_outbox)
    .set({ status: 'sending', claimed_at: sql`now()` })
    .where(sql`${bouncer_usage_event_outbox.id} IN (
      SELECT ${bouncer_usage_event_outbox.id}
      FROM ${bouncer_usage_event_outbox}
      WHERE ${bouncer_usage_event_outbox.status} = 'pending'
        AND coalesce(${bouncer_usage_event_outbox.next_attempt_at}, '-infinity'::timestamptz) <= now()
      ORDER BY ${bouncer_usage_event_outbox.created_at} ASC, ${bouncer_usage_event_outbox.id} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )`)
    .returning();
}

/**
 * Claims the one `pending` row for `requestId`, for the gateway's immediate delivery right after
 * the usage write commits. Returns null when the row is absent, already claimed by the drainer, or
 * already terminal, so the immediate delivery never races the drainer.
 */
export async function claimBouncerUsageEventByRequestId(
  database: BouncerUsageEventOutboxDatabase,
  requestId: string
): Promise<BouncerUsageEventOutboxRow | null> {
  const [row] = await database
    .update(bouncer_usage_event_outbox)
    .set({ status: 'sending', claimed_at: sql`now()` })
    .where(sql`${bouncer_usage_event_outbox.id} IN (
      SELECT ${bouncer_usage_event_outbox.id}
      FROM ${bouncer_usage_event_outbox}
      WHERE ${bouncer_usage_event_outbox.request_id} = ${requestId}
        AND ${bouncer_usage_event_outbox.status} = 'pending'
      FOR UPDATE SKIP LOCKED
    )`)
    .returning();
  return row ?? null;
}

/**
 * True when a non-terminal (`pending` or `sending`) outbox row exists for `requestId`, so the
 * drainer still owns its delivery. A `failed` row will never be sent again.
 */
export async function bouncerUsageEventInFlight(
  database: BouncerUsageEventOutboxDatabase,
  requestId: string
): Promise<boolean> {
  const [row] = await database
    .select({ id: bouncer_usage_event_outbox.id })
    .from(bouncer_usage_event_outbox)
    .where(
      and(
        eq(bouncer_usage_event_outbox.request_id, requestId),
        inArray(bouncer_usage_event_outbox.status, ['pending', 'sending'])
      )
    )
    .limit(1);
  return row !== undefined;
}

// ----- terminal marks -----------------------------------------------------------

function claimFence(input: { id: string; claimedAt: string }) {
  return and(
    eq(bouncer_usage_event_outbox.id, input.id),
    eq(bouncer_usage_event_outbox.status, 'sending'),
    eq(bouncer_usage_event_outbox.claimed_at, input.claimedAt)
  );
}

/** Marks a claimed row delivered, fenced on the claim; a stale mark returns null. */
export async function markBouncerUsageEventDelivered(
  database: BouncerUsageEventOutboxDatabase,
  input: { id: string; claimedAt: string }
): Promise<BouncerUsageEventOutboxRow | null> {
  const [updated] = await database
    .update(bouncer_usage_event_outbox)
    .set({ status: 'delivered', delivered_at: sql`now()`, next_attempt_at: null, claimed_at: null })
    .where(claimFence(input))
    .returning();
  return updated ?? null;
}

/**
 * Marks a claimed row for backoff retry, or terminal failure once the attempt cap is reached, in
 * one claim-fenced update.
 */
export async function markBouncerUsageEventRetry(
  database: BouncerUsageEventOutboxDatabase,
  input: { id: string; claimedAt: string; error?: string | null }
): Promise<BouncerUsageEventOutboxRetryResult | null> {
  const [row] = await database
    .update(bouncer_usage_event_outbox)
    .set({
      attempts: sql`${bouncer_usage_event_outbox.attempts} + 1`,
      status: sql`case when ${bouncer_usage_event_outbox.attempts} + 1 >= ${BOUNCER_USAGE_EVENT_OUTBOX_MAX_ATTEMPTS} then 'failed' else 'pending' end`,
      next_attempt_at: sql`case
        when ${bouncer_usage_event_outbox.attempts} + 1 >= ${BOUNCER_USAGE_EVENT_OUTBOX_MAX_ATTEMPTS} then null
        else now() + (least(${BOUNCER_USAGE_EVENT_OUTBOX_INITIAL_RETRY_BACKOFF_MS} * pow(2.0, ${bouncer_usage_event_outbox.attempts}::float8), ${BOUNCER_USAGE_EVENT_OUTBOX_MAX_RETRY_BACKOFF_MS}) * interval '1 millisecond')
      end`,
      claimed_at: null,
      last_error: input.error ?? null,
    })
    .where(claimFence(input))
    .returning();
  if (!row) return null;
  return row.attempts >= BOUNCER_USAGE_EVENT_OUTBOX_MAX_ATTEMPTS
    ? { outcome: 'failed', row }
    : { outcome: 'retried', row };
}

/** Force-marks a claimed row failed for a non-retryable outcome, fenced on the claim. */
export async function markBouncerUsageEventFailed(
  database: BouncerUsageEventOutboxDatabase,
  input: { id: string; claimedAt: string; error?: string | null }
): Promise<BouncerUsageEventOutboxRow | null> {
  const [updated] = await database
    .update(bouncer_usage_event_outbox)
    .set({
      status: 'failed',
      attempts: sql`${bouncer_usage_event_outbox.attempts} + 1`,
      next_attempt_at: null,
      claimed_at: null,
      last_error: input.error ?? null,
    })
    .where(claimFence(input))
    .returning();
  return updated ?? null;
}

/** Deletes a claimed row, fenced on the claim (a soft-deleted owner's row is dropped unsent). */
export async function deleteBouncerUsageEvent(
  database: BouncerUsageEventOutboxDatabase,
  input: { id: string; claimedAt: string }
): Promise<boolean> {
  const deleted = await database
    .delete(bouncer_usage_event_outbox)
    .where(claimFence(input))
    .returning({ id: bouncer_usage_event_outbox.id });
  return deleted.length > 0;
}

// ----- reclaim -----------------------------------------------------------------

/** Returns `sending` claims older than the stale window to `pending`. */
export async function reclaimStaleBouncerUsageEvents(
  database: BouncerUsageEventOutboxDatabase,
  limit: number
): Promise<BouncerUsageEventOutboxRow[]> {
  const staleBefore = new Date(
    Date.now() - BOUNCER_USAGE_EVENT_OUTBOX_STALE_SENDING_WINDOW_MS
  ).toISOString();
  return database
    .update(bouncer_usage_event_outbox)
    .set({ status: 'pending', claimed_at: null })
    .where(sql`${bouncer_usage_event_outbox.id} IN (
      SELECT ${bouncer_usage_event_outbox.id}
      FROM ${bouncer_usage_event_outbox}
      WHERE ${bouncer_usage_event_outbox.status} = 'sending'
        AND ${bouncer_usage_event_outbox.claimed_at} <= ${staleBefore}::timestamptz
      ORDER BY ${bouncer_usage_event_outbox.claimed_at} ASC, ${bouncer_usage_event_outbox.id} ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )`)
    .returning();
}

// ----- purge and retention -------------------------------------------------------

/** Deletes terminal rows past their retention window. */
export async function purgeExpiredBouncerUsageEvents(
  database: BouncerUsageEventOutboxDatabase,
  limit: number
): Promise<PurgeBouncerUsageEventOutboxResult> {
  const delivered = await database
    .delete(bouncer_usage_event_outbox)
    .where(sql`${bouncer_usage_event_outbox.id} IN (
      SELECT ${bouncer_usage_event_outbox.id}
      FROM ${bouncer_usage_event_outbox}
      WHERE ${bouncer_usage_event_outbox.status} = 'delivered'
        AND ${bouncer_usage_event_outbox.delivered_at} < now() - make_interval(days => ${BOUNCER_USAGE_EVENT_OUTBOX_DELIVERED_RETENTION_DAYS})
      ORDER BY ${bouncer_usage_event_outbox.delivered_at} ASC
      LIMIT ${limit}
    )`)
    .returning({ id: bouncer_usage_event_outbox.id });

  const failed = await database
    .delete(bouncer_usage_event_outbox)
    .where(sql`${bouncer_usage_event_outbox.id} IN (
      SELECT ${bouncer_usage_event_outbox.id}
      FROM ${bouncer_usage_event_outbox}
      WHERE ${bouncer_usage_event_outbox.status} = 'failed'
        AND ${bouncer_usage_event_outbox.created_at} < now() - make_interval(days => ${BOUNCER_USAGE_EVENT_OUTBOX_FAILED_RETENTION_DAYS})
      ORDER BY ${bouncer_usage_event_outbox.created_at} ASC
      LIMIT ${limit}
    )`)
    .returning({ id: bouncer_usage_event_outbox.id });

  return { deliveredPurged: delivered.length, failedPurged: failed.length };
}
