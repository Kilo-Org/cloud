/**
 * Integration tests for the durable Bouncer credit-event outbox state machine, against the
 * per-worker PostgreSQL test database. Rows are inserted directly as fixtures; production inserts
 * flow only through `enqueueCreditEvent`.
 */
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import { enqueueCreditEvent } from '@kilocode/web-shared/lib/bouncer/credit-events';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  bouncer_credit_event_outbox,
  kilocode_users,
  organizations,
  type BouncerCreditEventOutboxRow,
} from '@kilocode/db/schema';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete-reasons';
import {
  BOUNCER_CREDIT_EVENT_OUTBOX_INITIAL_RETRY_BACKOFF_MS,
  BOUNCER_CREDIT_EVENT_OUTBOX_MAX_ATTEMPTS,
  claimBouncerCreditEventByEventId,
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

    await db.transaction(tx =>
      enqueueCreditEvent(tx, {
        type: 'charge.failed',
        eventId: 'evt-short-identity',
        userId: user.id,
      })
    );

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

    await db.transaction(tx =>
      enqueueCreditEvent(tx, { type: 'charge.failed', eventId: longId, userId: user.id })
    );

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

    await db.transaction(tx =>
      enqueueCreditEvent(tx, {
        type: 'charge.failed',
        eventId: `${prefix}A`,
        userId: user.id,
      })
    );
    await db.transaction(tx =>
      enqueueCreditEvent(tx, {
        type: 'charge.failed',
        eventId: `${prefix}B`,
        userId: user.id,
      })
    );

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

    const result = await db.transaction(tx =>
      enqueueCreditEvent(tx, {
        type: 'charge.failed',
        eventId: 'evt-for-deleted-user',
        userId,
      })
    );

    expect(result.enqueued).toBe(false);
    const rows = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, 'evt-for-deleted-user'));
    expect(rows).toHaveLength(0);
  });

  it('reports an organization event against its family root with the family totals', async () => {
    const user = await insertTestUser();
    const parentCreatedAt = '2025-05-01T00:00:00.000Z';
    const [parent] = await db
      .insert(organizations)
      .values({
        name: 'Parent organization',
        created_at: parentCreatedAt,
        microdollars_used: 7_000,
        total_microdollars_acquired: 100_000,
      })
      .returning();
    const [child] = await db
      .insert(organizations)
      .values({
        name: 'Child organization',
        parent_organization_id: parent.id,
        microdollars_used: 2_000,
        total_microdollars_acquired: 5_000,
      })
      .returning();

    await db.transaction(tx =>
      enqueueCreditEvent(tx, {
        type: 'charge.attempted',
        eventId: 'evt-child-org-charge',
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        userId: user.id,
        orgId: child.id,
        flow: 'topup',
        amountCents: 2_000,
        accountCreatedAt: child.created_at,
        accountUsedMicrodollars: child.microdollars_used,
      })
    );

    const [row] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, 'evt-child-org-charge'));
    expect(row?.payload.orgId).toBe(parent.id);
    expect(row?.payload.accountUsedMicrodollars).toBe(9_000);
    expect(new Date(String(row?.payload.accountCreatedAt)).toISOString()).toBe(parentCreatedAt);

    await db.delete(organizations).where(eq(organizations.id, child.id));
    await db.delete(organizations).where(eq(organizations.id, parent.id));
  });

  it('enqueues an organization event when its attributed account is soft-deleted', async () => {
    const userId = 'oauth/deleted-org-actor';
    await insertTestUser({
      id: userId,
      blocked_reason: createSoftDeletedBlockedReason(),
    });
    const [org] = await db
      .insert(organizations)
      .values({
        name: 'Organization with a deleted billing actor',
        microdollars_used: 1_000,
        total_microdollars_acquired: 50_000,
      })
      .returning();

    const result = await db.transaction(tx =>
      enqueueCreditEvent(tx, {
        type: 'charge.attempted',
        eventId: 'evt-org-deleted-actor',
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        userId,
        orgId: org.id,
        flow: 'auto_topup',
        amountCents: 50_000,
        accountCreatedAt: org.created_at,
        accountUsedMicrodollars: org.microdollars_used,
        ip: '203.0.113.7',
        ipCountry: 'DE',
        ja4: 'ja4_digest_value',
        cardFingerprint: 'card_fingerprint_value',
        cardCountry: 'DE',
      })
    );

    expect(result.enqueued).toBe(true);
    const rows = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, 'evt-org-deleted-actor'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(userId);
    expect(rows[0]?.payload.orgId).toBe(org.id);
    expect(rows[0]?.payload.ip).toBeUndefined();
    expect(rows[0]?.payload.ipCountry).toBeUndefined();
    expect(rows[0]?.payload.ja4).toBeUndefined();
    expect(rows[0]?.payload.cardFingerprint).toBeUndefined();
    expect(rows[0]?.payload.cardCountry).toBeUndefined();

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it('keeps the client fields of an organization event for an active attributed account', async () => {
    const user = await insertTestUser();
    const [org] = await db
      .insert(organizations)
      .values({
        name: 'Organization with an active billing actor',
        microdollars_used: 3_000,
        total_microdollars_acquired: 20_000,
      })
      .returning();

    const result = await db.transaction(tx =>
      enqueueCreditEvent(tx, {
        type: 'charge.attempted',
        eventId: 'evt-org-active-actor',
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        userId: user.id,
        orgId: org.id,
        flow: 'auto_topup',
        amountCents: 5_000,
        accountCreatedAt: org.created_at,
        accountUsedMicrodollars: org.microdollars_used,
        ip: '203.0.113.7',
        ja4: 'ja4_digest_value',
      })
    );

    expect(result.enqueued).toBe(true);
    const rows = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, 'evt-org-active-actor'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.ip).toBe('203.0.113.7');
    expect(rows[0]?.payload.ja4).toBe('ja4_digest_value');

    await db.delete(organizations).where(eq(organizations.id, org.id));
  });

  it('serializes an organization enqueue against a concurrent account cleanup', async () => {
    const user = await insertTestUser();
    const [org] = await db
      .insert(organizations)
      .values({
        name: 'Organization charged during an account cleanup',
        microdollars_used: 4_000,
        total_microdollars_acquired: 30_000,
      })
      .returning();

    const { promise: lockHeld, resolve: signalLockHeld } = Promise.withResolvers<number>();
    const { promise: releaseGate, resolve: allowEnqueue } = Promise.withResolvers<void>();

    // The holder mirrors `anonymizeCloudUserData`: it deletes this account's outbox rows and marks
    // the row gone in one transaction, and keeps that row locked until it commits.
    const cleanup = db.transaction(async tx => {
      await tx
        .delete(bouncer_credit_event_outbox)
        .where(eq(bouncer_credit_event_outbox.user_id, user.id));
      await tx
        .update(kilocode_users)
        .set({ blocked_reason: createSoftDeletedBlockedReason() })
        .where(eq(kilocode_users.id, user.id));
      const backend = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
      const pid = backend.rows[0]?.pid;
      if (pid === undefined) throw new Error('PostgreSQL backend pid unavailable');
      signalLockHeld(pid);
      await releaseGate;
    });

    const holderPid = await lockHeld;
    const enqueue = db.transaction(tx =>
      enqueueCreditEvent(tx, {
        type: 'charge.attempted',
        eventId: 'evt-org-concurrent-cleanup',
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        userId: user.id,
        orgId: org.id,
        flow: 'auto_topup',
        amountCents: 7_000,
        accountCreatedAt: org.created_at,
        accountUsedMicrodollars: org.microdollars_used,
        ip: '203.0.113.7',
        ja4: 'ja4_digest_value',
        cardFingerprint: 'card_fingerprint_value',
      })
    );

    // The loop below proves the enqueue waits on the cleanup backend; it throws with diagnostics
    // when the waiter never registers. Release the gate either way.
    try {
      const deadline = Date.now() + 10_000;
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
      for (;;) {
        const waiting = await db.execute(sql`
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND ${holderPid} = ANY(pg_blocking_pids(pid))`);
        if (waiting.rows.length > 0) break;
        if (Date.now() > deadline) {
          const diagnostics = await db.execute<{ wait: string | null; query: string }>(sql`
            SELECT wait_event_type || ':' || coalesce(wait_event, '') AS wait, query
            FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()`);
          throw new Error(
            `timed out waiting for the cleanup backend to block the enqueue; activity: ${JSON.stringify(diagnostics.rows)}`
          );
        }
        await sleep(20);
      }
    } finally {
      allowEnqueue();
    }

    await Promise.all([cleanup, enqueue]);

    const rows = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.event_id, 'evt-org-concurrent-cleanup'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.orgId).toBe(org.id);
    expect(rows[0]?.payload.ip).toBeUndefined();
    expect(rows[0]?.payload.ja4).toBeUndefined();
    expect(rows[0]?.payload.cardFingerprint).toBeUndefined();

    await db.delete(organizations).where(eq(organizations.id, org.id));
  }, 30_000);

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

  it('claims a backoff-waiting row by event id while the drainer holds it', async () => {
    await insertOutboxRow({
      event_id: 'evt-backoff-waiting',
      event_type: 'charge.failed',
      user_id: 'user-1',
      payload: { type: 'charge.failed' },
      next_attempt_at: new Date(Date.now() + HOUR_MS).toISOString(),
    });

    // The drainer honours the retry deadline, so a backoff-waiting row is not due.
    const due = await claimDueBouncerCreditEvents(db, 10);
    expect(due).toHaveLength(0);

    // The webhook's immediate delivery is not a retry attempt, so it claims the row anyway.
    const claimed = await claimBouncerCreditEventByEventId(db, 'evt-backoff-waiting');
    expect(claimed?.event_id).toBe('evt-backoff-waiting');
    expect(claimed?.status).toBe('sending');
    expect(claimed?.claimed_at).not.toBeNull();
  });

  it('claims only one row when an event id has several event types', async () => {
    const createdAt = new Date().toISOString();
    await insertOutboxRow({
      event_id: 'evt-two-types',
      event_type: 'charge.failed',
      user_id: 'user-1',
      payload: { type: 'charge.failed' },
      created_at: createdAt,
    });
    await insertOutboxRow({
      event_id: 'evt-two-types',
      event_type: 'charge.refunded',
      user_id: 'user-1',
      payload: { type: 'charge.refunded' },
      created_at: createdAt,
    });

    const claimed = await claimBouncerCreditEventByEventId(db, 'evt-two-types');
    expect(claimed?.status).toBe('sending');

    // The sibling must stay claimable by the drainer, not be stamped `sending` and delivered by
    // nobody until the stale-claim window reclaims it.
    const rows = await db.select().from(bouncer_credit_event_outbox);
    expect(rows.filter(row => row.status === 'sending')).toHaveLength(1);
    expect(rows.filter(row => row.status === 'pending')).toHaveLength(1);
  });

  it('does not reclaim a fresh claim when the caller clock runs ahead', async () => {
    const now = Date.now();
    await insertOutboxRow({
      event_id: 'evt-claimed-recently',
      event_type: 'charge.failed',
      user_id: 'user-1',
      payload: { type: 'charge.failed' },
      status: 'sending',
      claimed_at: new Date(now - 60 * 1000).toISOString(),
    });
    await insertOutboxRow({
      event_id: 'evt-claimed-long-ago',
      event_type: 'charge.failed',
      user_id: 'user-1',
      payload: { type: 'charge.failed' },
      status: 'sending',
      claimed_at: new Date(now - 6 * 60 * 1000).toISOString(),
    });

    // The stale window is measured on the database clock, so a host clock running ahead cannot
    // widen it.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now + HOUR_MS);
    try {
      const reclaimed = await reclaimStaleBouncerCreditEvents(db, 10);
      expect(reclaimed.map(row => row.event_id)).toEqual(['evt-claimed-long-ago']);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
