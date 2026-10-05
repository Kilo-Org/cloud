/**
 * Integration tests for the durable Bouncer credit-event outbox state machine, against the
 * per-worker PostgreSQL test database. Rows are inserted directly as fixtures; production inserts
 * flow only through `enqueueCreditEvent`.
 */
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import { enqueueCreditEvent } from '@/lib/bouncer/credit-events';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { bouncer_credit_event_outbox, type BouncerCreditEventOutboxRow } from '@kilocode/db/schema';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete-reasons';
import {
  BOUNCER_CREDIT_EVENT_OUTBOX_INITIAL_RETRY_BACKOFF_MS,
  BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS,
  claimDueBouncerCreditEvents,
  enqueueBouncerCreditEvent,
  markBouncerCreditEventDelivered,
  markBouncerCreditEventRetry,
  markBouncerCreditEventFailed,
  purgeExpiredBouncerCreditEvents,
  reclaimStaleBouncerCreditEvents,
} from '@kilocode/db/bouncer-credit-event-outbox';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function insertOutboxRow(
  overrides: Partial<typeof bouncer_credit_event_outbox.$inferInsert> = {}
) {
  const [row] = await db
    .insert(bouncer_credit_event_outbox)
    .values({
      event_id: randomUUID(),
      event_type: 'charge.failed',
      user_id: 'user-outbox-test',
      payload: { type: 'charge.failed' },
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('Outbox row insert returned no row');
  return row;
}

/** Claims the single due pending row and returns it with its claim token. */
async function claimFirstEvent(): Promise<{
  row: BouncerCreditEventOutboxRow;
  claimToken: string;
}> {
  const [row] = await claimDueBouncerCreditEvents(db, 10);
  if (!row) throw new Error('claimDueBouncerCreditEvents returned no row');
  if (!row.claimed_at) throw new Error('claimed event has no claimed_at');
  return { row, claimToken: row.claimed_at };
}

describe('bouncer credit-event outbox (integration)', () => {
  beforeEach(async () => {
    await db.delete(bouncer_credit_event_outbox).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(bouncer_credit_event_outbox).where(sql`true`);
  });

  it('enqueues idempotently on (event_id, event_type)', async () => {
    const input = {
      eventId: 'evt-stable-1',
      eventType: 'charge.succeeded',
      userId: 'user-1',
      payload: { type: 'charge.succeeded', eventId: 'evt-stable-1', userId: 'user-1' },
    };

    const first = await enqueueBouncerCreditEvent(db, input);
    const second = await enqueueBouncerCreditEvent(db, input);

    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    const rows = await db.select().from(bouncer_credit_event_outbox);
    expect(rows).toHaveLength(1);
  });

  it('keeps a normal-length source id unchanged as the wire identity and dedupe key', async () => {
    const user = await insertTestUser();

    await enqueueCreditEvent(db, {
      type: 'charge.failed',
      eventId: 'evt-short-identity',
      userId: user.id,
    });

    const [row] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, 'evt-short-identity'));
    expect(row?.event_id).toBe('evt-short-identity');
    expect(row?.payload.eventId).toBe('evt-short-identity');
  });

  it('hashes a source id longer than 128 chars so the wire identity stays distinct', async () => {
    const user = await insertTestUser();
    const longId = 'e'.repeat(200);

    await enqueueCreditEvent(db, { type: 'charge.failed', eventId: longId, userId: user.id });

    const [row] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.user_id, user.id));
    expect(row?.event_id).toHaveLength(64);
    expect(row?.payload.eventId).toBe(row?.event_id);
  });

  it('keeps two long ids sharing a 128-char prefix as two distinct events', async () => {
    const user = await insertTestUser();
    const prefix = 'p'.repeat(128);

    await enqueueCreditEvent(db, {
      type: 'charge.failed',
      eventId: `${prefix}A`,
      userId: user.id,
    });
    await enqueueCreditEvent(db, {
      type: 'charge.failed',
      eventId: `${prefix}B`,
      userId: user.id,
    });

    const rows = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.user_id, user.id));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.event_id)).size).toBe(2);
  });

  it('refuses to enqueue a credit event for a soft-deleted account', async () => {
    const userId = 'oauth/deleted-outbox-user';
    await insertTestUser({
      id: userId,
      blocked_reason: createSoftDeletedBlockedReason(),
    });

    const result = await enqueueCreditEvent(db, {
      type: 'charge.failed',
      eventId: 'evt-for-deleted-user',
      userId,
    });

    expect(result.enqueued).toBe(false);
    const rows = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, 'evt-for-deleted-user'));
    expect(rows).toHaveLength(0);
  });

  it('treats the same event_id with a different type as a distinct row', async () => {
    await enqueueBouncerCreditEvent(db, {
      eventId: 'shared-id',
      eventType: 'charge.failed',
      userId: 'user-1',
      payload: { type: 'charge.failed' },
    });
    await enqueueBouncerCreditEvent(db, {
      eventId: 'shared-id',
      eventType: 'charge.succeeded',
      userId: 'user-1',
      payload: { type: 'charge.succeeded' },
    });

    const rows = await db.select().from(bouncer_credit_event_outbox);
    expect(rows).toHaveLength(2);
  });

  it('rolls back an enqueue inside a failed transaction (atomic with the primary write)', async () => {
    await expect(
      db.transaction(async tx => {
        await enqueueBouncerCreditEvent(tx, {
          eventId: 'evt-rollback',
          eventType: 'store.purchase',
          userId: 'user-1',
          payload: { type: 'store.purchase' },
        });
        throw new Error('primary write failed');
      })
    ).rejects.toThrow('primary write failed');

    const rows = await db.select().from(bouncer_credit_event_outbox);
    expect(rows).toHaveLength(0);
  });

  it('claims only due pending rows, oldest first, and marks them sending', async () => {
    const future = new Date(Date.now() + HOUR_MS).toISOString();
    const past = new Date(Date.now() - HOUR_MS).toISOString();
    const firstDue = await insertOutboxRow({ created_at: past });
    const secondDue = await insertOutboxRow();
    const notDue = await insertOutboxRow({ next_attempt_at: future });

    const claimed = await claimDueBouncerCreditEvents(db, 10);
    expect(claimed.map(row => row.id).sort()).toEqual([firstDue.id, secondDue.id].sort());
    for (const row of claimed) {
      expect(row.status).toBe('sending');
      expect(row.claimed_at).not.toBeNull();
    }

    const [stillPending] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.id, notDue.id));
    expect(stillPending?.status).toBe('pending');
  });

  it('fences a delivery mark on the claim token', async () => {
    await insertOutboxRow();
    const { row, claimToken } = await claimFirstEvent();

    const stale = await markBouncerCreditEventDelivered(db, {
      id: row.id,
      claimedAt: new Date(Date.now() - HOUR_MS).toISOString(),
    });
    expect(stale).toBeNull();

    const delivered = await markBouncerCreditEventDelivered(db, {
      id: row.id,
      claimedAt: claimToken,
    });
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.delivered_at).not.toBeNull();
  });

  it('backs off a retry and fails the row after the attempt cap', async () => {
    const [row] = await db
      .insert(bouncer_credit_event_outbox)
      .values({
        event_id: 'evt-retry',
        event_type: 'charge.failed',
        user_id: 'user-1',
        payload: { type: 'charge.failed' },
        attempts: BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS - 1,
      })
      .returning();
    if (!row) throw new Error('insert failed');

    const { claimToken } = await claimFirstEvent();
    const retry = await markBouncerCreditEventRetry(db, {
      id: row.id,
      claimedAt: claimToken,
      error: 'network',
    });
    expect(retry?.outcome).toBe('failed');
    expect(retry?.row.next_attempt_at).toBeNull();
    expect(retry?.row.last_error).toBe('network');
  });

  it('sets an exponential backoff deadline on a retry below the cap', async () => {
    await insertOutboxRow();
    const { row, claimToken } = await claimFirstEvent();

    const retry = await markBouncerCreditEventRetry(db, { id: row.id, claimedAt: claimToken });
    expect(retry?.outcome).toBe('retried');
    expect(retry?.row.status).toBe('pending');
    const nextAttemptMs = retry?.row.next_attempt_at
      ? new Date(retry.row.next_attempt_at).getTime()
      : 0;
    expect(nextAttemptMs).toBeGreaterThanOrEqual(
      Date.now() + BOUNCER_CREDIT_EVENT_OUTBOX_INITIAL_RETRY_BACKOFF_MS - 5_000
    );
  });

  it('force-marks a row failed and is fenced on the claim token', async () => {
    await insertOutboxRow();
    const { row, claimToken } = await claimFirstEvent();

    expect(
      await markBouncerCreditEventFailed(db, {
        id: row.id,
        claimedAt: new Date(Date.now() - HOUR_MS).toISOString(),
        error: 'stale',
      })
    ).toBeNull();

    const failed = await markBouncerCreditEventFailed(db, {
      id: row.id,
      claimedAt: claimToken,
      error: 'invalid_payload',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.last_error).toBe('invalid_payload');
  });

  it('reclaims a stale sending claim back to pending (bounded)', async () => {
    const staleClaim = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const [staleRow] = await db
      .insert(bouncer_credit_event_outbox)
      .values({
        event_id: 'evt-stale',
        event_type: 'charge.failed',
        user_id: 'user-1',
        payload: { type: 'charge.failed' },
        status: 'sending',
        claimed_at: staleClaim,
      })
      .returning();
    if (!staleRow) throw new Error('insert failed');
    // A fresh claim must not be reclaimed.
    await db.insert(bouncer_credit_event_outbox).values({
      event_id: 'evt-fresh',
      event_type: 'charge.failed',
      user_id: 'user-1',
      payload: { type: 'charge.failed' },
      status: 'sending',
      claimed_at: new Date().toISOString(),
    });

    const reclaimed = await reclaimStaleBouncerCreditEvents(db, 10);
    expect(reclaimed.map(row => row.id)).toEqual([staleRow.id]);

    const [fresh] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, 'evt-fresh'));
    expect(fresh?.status).toBe('sending');
  });

  it('purges terminal rows past retention, bounded, and keeps recent ones', async () => {
    const ancient = new Date(Date.now() - 40 * DAY_MS).toISOString();
    await insertOutboxRow({
      event_id: 'evt-old-delivered',
      status: 'delivered',
      delivered_at: ancient,
      created_at: ancient,
    });
    await insertOutboxRow({
      event_id: 'evt-old-failed',
      status: 'failed',
      created_at: ancient,
    });
    await insertOutboxRow({
      event_id: 'evt-recent-delivered',
      status: 'delivered',
      delivered_at: new Date().toISOString(),
    });

    const purged = await purgeExpiredBouncerCreditEvents(db, 100);
    expect(purged.deliveredPurged).toBe(1);
    expect(purged.failedPurged).toBe(1);

    const rows = await db.select().from(bouncer_credit_event_outbox);
    expect(rows.map(row => row.event_id)).toEqual(['evt-recent-delivered']);
  });
});
