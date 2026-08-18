/**
 * Durable outbox for live side effects written atomically with the primary
 * write (P2-B-11). The only operation today is the organization invite email:
 * the invite mutation enqueues a row instead of sending inline, and the cron
 * drainer moves rows through the delivery states.
 *
 * - `pending` → (claim) → `sending` → (delivered) → `delivered`
 * - `sending` → (send error) → backoff retry → `pending` with `next_attempt_at`
 * - `pending` → ... after `INVITE_EMAIL_OUTBOX_MAX_ATTEMPTS` attempts → `failed`
 * - `sending` claims older than `INVITE_EMAIL_OUTBOX_STALE_SENDING_WINDOW_MS`
 *   → reclaimed to `pending`
 *
 * Delivery marks (`markInviteEmailDelivered`, `markInviteEmailRetry`,
 * `markInviteEmailFailed`) are fenced on the claim: each takes the `claimed_at`
 * token returned by the claim and updates only while the row is still that
 * `sending` claim. A late mark from a sender whose claim was reclaimed and
 * re-claimed is a no-op.
 *
 * `resetInviteEmailForResend` resets the existing row for a `resendInvite`
 * mutation: it returns the row to `pending` with a cleared attempt clock and
 * never inserts a second row, so the unique `invitation_id` constraint holds.
 */
import { and, eq, exists, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';

import type * as schema from './schema';
import {
  external_side_effect_outbox,
  organization_invitations,
  type ExternalSideEffectOutboxPayload,
  type ExternalSideEffectOutboxRow,
} from './schema';

// ----- constants -----------------------------------------------------------

/** A row fails terminally after this many send attempts. */
export const INVITE_EMAIL_OUTBOX_MAX_ATTEMPTS = 8;

/** A `sending` claim older than this is stale and gets reclaimed. */
export const INVITE_EMAIL_OUTBOX_STALE_SENDING_WINDOW_MS = 5 * 60 * 1000;

/** Retry backoff constants (same shape as the analytics outbox drainer). */
export const INVITE_EMAIL_OUTBOX_INITIAL_RETRY_BACKOFF_MS = 60 * 1000;
export const INVITE_EMAIL_OUTBOX_MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;

// ----- connection types ------------------------------------------------------

export type SideEffectOutboxTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/** Accepts either a `NodePgDatabase` or an open transaction. */
export type SideEffectOutboxDatabase = NodePgDatabase<typeof schema> | SideEffectOutboxTransaction;

// ----- result types -----------------------------------------------------------

export type InviteEmailOutboxRetryResult =
  | { outcome: 'retried'; row: ExternalSideEffectOutboxRow }
  | { outcome: 'failed'; row: ExternalSideEffectOutboxRow };

// ----- enqueue ------------------------------------------------------------------

/**
 * Enqueues one invite-email side effect. The unique `invitation_id` constraint
 * makes a retry of the same invite a no-op that throws, so a caller can never
 * enqueue the same invite twice.
 */
export async function enqueueInviteEmail(
  database: SideEffectOutboxDatabase,
  input: { invitationId: string; payload: ExternalSideEffectOutboxPayload }
): Promise<ExternalSideEffectOutboxRow> {
  const [row] = await database
    .insert(external_side_effect_outbox)
    .values({
      operation: 'send_org_invite_email',
      invitation_id: input.invitationId,
      payload: input.payload,
    })
    .returning();
  return row;
}

// ----- claim ------------------------------------------------------------------

/**
 * Claims due `pending` rows in a bounded batch: transitions them to `sending`
 * with `claimed_at`, ordered oldest-first, `FOR UPDATE SKIP LOCKED` so
 * concurrent drainers never double-claim. A row is due when
 * `next_attempt_at` is null or in the past. The claim is fenced on the linked
 * invitation still being valid (`accepted_at IS NULL AND expires_at > now()`),
 * so an invitee who accepts before the next pass, or whose invite expires in
 * retry backoff, is never emailed.
 */
export async function claimDueInviteEmails(
  database: SideEffectOutboxDatabase,
  limit: number
): Promise<ExternalSideEffectOutboxRow[]> {
  return database
    .update(external_side_effect_outbox)
    .set({
      status: 'sending',
      claimed_at: sql`now()`,
    })
    .where(sql`${external_side_effect_outbox.id} IN (
      SELECT ${external_side_effect_outbox.id}
      FROM ${external_side_effect_outbox}
      WHERE ${external_side_effect_outbox.status} = 'pending'
        AND coalesce(${external_side_effect_outbox.next_attempt_at}, '-infinity'::timestamptz) <= now()
        AND ${exists(
          database
            .select({ one: sql`1` })
            .from(organization_invitations)
            .where(
              and(
                eq(organization_invitations.id, external_side_effect_outbox.invitation_id),
                isNull(organization_invitations.accepted_at),
                gt(organization_invitations.expires_at, sql`now()`)
              )
            )
        )}
      ORDER BY ${external_side_effect_outbox.created_at} ASC, ${external_side_effect_outbox.id} ASC
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
export async function markInviteEmailDelivered(
  database: SideEffectOutboxDatabase,
  input: { id: string; claimedAt: string }
): Promise<ExternalSideEffectOutboxRow | null> {
  const [updated] = await database
    .update(external_side_effect_outbox)
    .set({
      status: 'delivered',
      delivered_at: sql`now()`,
      next_attempt_at: null,
      claimed_at: null,
    })
    .where(
      and(
        eq(external_side_effect_outbox.id, input.id),
        eq(external_side_effect_outbox.status, 'sending'),
        eq(external_side_effect_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();
  return updated ?? null;
}

/**
 * Marks a claimed row for backoff retry or terminal failure in one atomic,
 * claim-fenced update. When the new attempt count reaches
 * `INVITE_EMAIL_OUTBOX_MAX_ATTEMPTS` the row transitions to `failed` with
 * `next_attempt_at` cleared; otherwise it returns to `pending` with the
 * exponential backoff deadline.
 */
export async function markInviteEmailRetry(
  database: SideEffectOutboxDatabase,
  input: { id: string; claimedAt: string; error?: string | null }
): Promise<InviteEmailOutboxRetryResult | null> {
  const [row] = await database
    .update(external_side_effect_outbox)
    .set({
      attempts: sql`${external_side_effect_outbox.attempts} + 1`,
      status: sql`case when ${external_side_effect_outbox.attempts} + 1 >= ${INVITE_EMAIL_OUTBOX_MAX_ATTEMPTS} then 'failed' else 'pending' end`,
      next_attempt_at: sql`case
        when ${external_side_effect_outbox.attempts} + 1 >= ${INVITE_EMAIL_OUTBOX_MAX_ATTEMPTS} then null
        else now() + (least(${INVITE_EMAIL_OUTBOX_INITIAL_RETRY_BACKOFF_MS} * pow(2.0, ${external_side_effect_outbox.attempts}::float8), ${INVITE_EMAIL_OUTBOX_MAX_RETRY_BACKOFF_MS}) * interval '1 millisecond')
      end`,
      claimed_at: null,
      last_error: input.error ?? null,
    })
    .where(
      and(
        eq(external_side_effect_outbox.id, input.id),
        eq(external_side_effect_outbox.status, 'sending'),
        eq(external_side_effect_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();

  if (!row) {
    // The claim is no longer active (reclaimed, delivered, or failed).
    return null;
  }

  return row.attempts >= INVITE_EMAIL_OUTBOX_MAX_ATTEMPTS
    ? { outcome: 'failed', row }
    : { outcome: 'retried', row };
}

/**
 * Force-marks a claimed row failed (used for definitive, non-retryable send
 * errors). Fenced on the claim token `claimedAt`; a late mark from a stale
 * sender affects zero rows and returns null.
 */
export async function markInviteEmailFailed(
  database: SideEffectOutboxDatabase,
  input: { id: string; claimedAt: string; error?: string | null }
): Promise<ExternalSideEffectOutboxRow | null> {
  const [updated] = await database
    .update(external_side_effect_outbox)
    .set({
      status: 'failed',
      attempts: sql`${external_side_effect_outbox.attempts} + 1`,
      next_attempt_at: null,
      claimed_at: null,
      last_error: input.error ?? null,
    })
    .where(
      and(
        eq(external_side_effect_outbox.id, input.id),
        eq(external_side_effect_outbox.status, 'sending'),
        eq(external_side_effect_outbox.claimed_at, input.claimedAt)
      )
    )
    .returning();
  return updated ?? null;
}

// ----- reclaim -----------------------------------------------------------------

/**
 * Reclaims `sending` rows whose claim is older than
 * `INVITE_EMAIL_OUTBOX_STALE_SENDING_WINDOW_MS`: they return to `pending` and
 * become due again. Covers the crash window where a drainer died after claiming.
 */
export async function reclaimStaleInviteEmails(
  database: SideEffectOutboxDatabase
): Promise<ExternalSideEffectOutboxRow[]> {
  const staleBefore = new Date(
    Date.now() - INVITE_EMAIL_OUTBOX_STALE_SENDING_WINDOW_MS
  ).toISOString();
  return database
    .update(external_side_effect_outbox)
    .set({ status: 'pending', claimed_at: null })
    .where(
      and(
        eq(external_side_effect_outbox.status, 'sending'),
        sql`${external_side_effect_outbox.claimed_at} <= ${staleBefore}::timestamptz`
      )
    )
    .returning();
}

// ----- resend -----------------------------------------------------------------

/**
 * Resets the existing outbox row for a `resendInvite` mutation: returns it to
 * `pending` with a cleared attempt clock and error, ready for the next cron
 * pass. It updates the existing row rather than inserting a second one, so the
 * unique `invitation_id` constraint is never violated.
 *
 * The update is fenced on the linked invitation still being valid: it only
 * matches while the `organization_invitations` row has `expires_at > now()` and
 * `accepted_at IS NULL`. A concurrent `deleteInvite` that expires the invite
 * and marks the outbox row `failed` therefore wins: the reset affects zero rows
 * and returns null, so cron never re-arms a revoked/expired/accepted invite.
 *
 * The update is also fenced on outbox status: it only matches a row in
 * `pending`, `delivered`, or `failed`. A `resendInvite` that lands while cron
 * holds a `sending` claim matches zero rows and returns null, so the in-flight
 * sender's claim token is never invalidated and the invitee is not emailed
 * twice.
 */
export async function resetInviteEmailForResend(
  database: SideEffectOutboxDatabase,
  invitationId: string
): Promise<ExternalSideEffectOutboxRow | null> {
  const [updated] = await database
    .update(external_side_effect_outbox)
    .set({
      status: 'pending',
      attempts: 0,
      next_attempt_at: sql`now()`,
      claimed_at: null,
      last_error: null,
    })
    .where(
      and(
        eq(external_side_effect_outbox.invitation_id, invitationId),
        inArray(external_side_effect_outbox.status, ['pending', 'delivered', 'failed']),
        inArray(
          external_side_effect_outbox.invitation_id,
          database
            .select({ id: organization_invitations.id })
            .from(organization_invitations)
            .where(
              and(
                gt(organization_invitations.expires_at, sql`now()`),
                isNull(organization_invitations.accepted_at)
              )
            )
        )
      )
    )
    .returning();
  return updated ?? null;
}
