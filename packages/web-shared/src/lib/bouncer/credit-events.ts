import 'server-only';

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

import {
  bouncerWireEventId,
  creditEventWireBody,
  normalizeJa4,
  type CreditEvent,
  type CreditFlow,
} from '@kilocode/web-shared/lib/bouncer/client';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import {
  enqueueBouncerCreditEvent,
  type BouncerCreditEventOutboxDatabase,
  type EnqueueBouncerCreditEventResult,
} from '@kilocode/db/bouncer-credit-event-outbox';
import { kilocode_users } from '@kilocode/db/schema';
import { isGoneOrDeletingBlockedReason } from '@kilocode/db/user-soft-delete-reasons';

const logWarning = sentryLogger('bouncer-credit-event-outbox', 'warning');

/** `x-vercel-ip-country` from request headers, for a bouncer `ipCountry`. */
export function ipCountryFromHeaders(headers?: Headers | null): string | null {
  return headers?.get('x-vercel-ip-country')?.trim() || null;
}

/**
 * `x-vercel-ja4-digest` from request headers, normalized to bouncer's bounded opaque digest
 * (`^[a-z0-9_]{1,128}$`), or null when the header is missing or invalid. It fingerprints the
 * client TLS/HTTP characteristics of the peer that reached Kilo's edge, not a person or device.
 */
export function ja4FromHeaders(headers?: Headers | null): string | null {
  return normalizeJa4(headers?.get('x-vercel-ja4-digest')) ?? null;
}

/**
 * Enqueues one credit event into the durable outbox. The soft-delete check locks the user row
 * `FOR UPDATE`, so it must run inside a transaction (the callers pass `db.transaction` or an open
 * transaction) for the lock to hold. That serializes the enqueue insert against a concurrent
 * `softDeleteUser` (which updates the same row) at the database boundary, so an in-flight late
 * webhook cannot insert after the deletion commits; it does not undo a delivery that already
 * happened, and the drainer rechecks the owner before sending. Passing the caller's transaction
 * also makes the insert atomic with the primary write. A DB error propagates, so the caller can let
 * the payment or webhook provider retry instead of losing the report. The insert is idempotent on
 * `(eventId, event_type)`.
 *
 * The row keeps the raw `userId` (so a soft delete can find it by the real user id). `event_id` is
 * `bouncerWireEventId(event.eventId)` — the exact id when within bouncer's 128-character limit,
 * else a SHA-256 digest — so the dedupe key equals the id bouncer receives and two distinct source
 * events never merge. The payload is the same wire body. A gone/deleting account is skipped with a
 * visible log.
 */
export async function enqueueCreditEvent(
  database: BouncerCreditEventOutboxDatabase,
  event: CreditEvent
): Promise<EnqueueBouncerCreditEventResult> {
  const [owner] = await database
    .select({ blockedReason: kilocode_users.blocked_reason })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, event.userId))
    .limit(1)
    .for('update');
  if (owner && isGoneOrDeletingBlockedReason(owner.blockedReason)) {
    logWarning('Skipped bouncer credit event for a soft-deleted user', {
      eventType: event.type,
      eventId: event.eventId,
    });
    return { enqueued: false };
  }
  return enqueueBouncerCreditEvent(database, {
    // The dedupe key is the wire identity (exact when <=128 chars, else SHA-256), the same value
    // bouncer receives, so two source ids never collapse to one identity.
    eventId: bouncerWireEventId(event.eventId),
    eventType: event.type,
    userId: event.userId,
    payload: creditEventWireBody(event),
  });
}

/**
 * The context a `charge.attempted` needs in addition to the flow-specific fields. `accountCreatedAt`
 * is `users.created_at` for a personal charge and `organizations.created_at` for an org charge.
 */
export type ChargeAttemptContext = {
  accountCreatedAt: Date | string;
  /** The client IP. Omit it for an off-session charge. */
  ip?: string | null;
  ipCountry?: string | null;
  cardFingerprint?: string | null;
  cardCountry?: string | null;
  /**
   * The bounded client-fingerprint digest from the request's Vercel header, when valid. It
   * fingerprints the client TLS/HTTP characteristics of the peer that reached Kilo's edge, not a
   * person or device; omit it for an off-session charge, which has no client request.
   */
  ja4?: string | null;
};

/**
 * Enqueues one `charge.attempted` on the caller's transaction, with the caller's stable `eventId`.
 * A checkout hook that already holds a transaction (and knows the session id it is charging) uses
 * this so the report commits atomically with the checkout decision, is idempotent across a reuse of
 * the same session, and adds no second database connection. The event time is stamped once here, so
 * a delayed retry keeps the original attempt time.
 */
export async function enqueueChargeAttempted(
  database: BouncerCreditEventOutboxDatabase,
  params: {
    /** A stable id, for example derived from the checkout session id, so a retry/reuse dedupes. */
    eventId: string;
    flow: CreditFlow;
    userId: string;
    orgId?: string | null;
    amountCents: number;
  } & ChargeAttemptContext
): Promise<void> {
  await enqueueCreditEvent(database, {
    type: 'charge.attempted',
    eventId: params.eventId,
    occurredAt: new Date(),
    flow: params.flow,
    userId: params.userId,
    orgId: params.orgId,
    amountCents: params.amountCents,
    accountCreatedAt: params.accountCreatedAt,
    ip: params.ip,
    ipCountry: params.ipCountry,
    cardFingerprint: params.cardFingerprint,
    cardCountry: params.cardCountry,
    ja4: params.ja4,
  });
}

/**
 * Durably enqueues a `charge.attempted` for a charge or checkout the caller is about to create.
 *
 * Awaited by the caller: a DB error propagates rather than being floated, so a missing enqueue is
 * never silently accepted. It performs no HTTP, so it never delays a checkout on bouncer. The
 * generated `eventId` is chosen once at the request boundary and never regenerated by a retry. A
 * Stripe webhook outcome later carries the Stripe event id. Callers inside an existing transaction
 * use `enqueueChargeAttempted` directly instead, to avoid a second connection.
 */
export async function reportChargeAttempted(
  params: {
    flow: CreditFlow;
    userId: string;
    orgId?: string | null;
    amountCents: number;
  } & ChargeAttemptContext
): Promise<void> {
  const eventId = randomUUID();
  // The check + insert run in one transaction so the user-row lock serializes with a concurrent
  // soft delete.
  await db.transaction(tx => enqueueChargeAttempted(tx, { ...params, eventId }));
}
