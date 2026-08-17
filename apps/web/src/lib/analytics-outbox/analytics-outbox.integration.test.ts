/**
 * Integration tests for the durable analytics outbox state machine (P2-A-04),
 * against the per-worker PostgreSQL test database. Rows are inserted directly
 * as fixtures; production inserts flow only through the ledger settle helpers
 * in `packages/db/src/operation-ledger.ts`.
 */
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  analytics_event_outbox,
  operation_ledgers,
  type AnalyticsEventOutboxRow,
} from '@kilocode/db/schema';
import {
  claimDueOutboxEvents,
  markOutboxDelivered,
  markOutboxRetry,
  markOutboxFailed,
  reclaimStaleSendingEvents,
  purgeExpired,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_INITIAL_RETRY_BACKOFF_MS,
  OUTBOX_MAX_RETRY_BACKOFF_MS,
  EXPIRED_UNSETTLED_OUTCOME_CODE,
} from '@kilocode/db/analytics-outbox';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

async function insertOutboxRow(
  overrides: Partial<typeof analytics_event_outbox.$inferInsert> = {}
) {
  const [row] = await db
    .insert(analytics_event_outbox)
    .values({
      event_uuid: randomUUID(),
      event_name: 'session_create_settled',
      distinct_id: 'user@example.com',
      properties: { source: 'server' },
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('Outbox row insert returned no row');
  return row;
}

/** Claims the single due pending row and returns it with its claim token. */
async function claimFirstEvent(): Promise<{ row: AnalyticsEventOutboxRow; claimToken: string }> {
  const [row] = await claimDueOutboxEvents(db, 10);
  if (!row) throw new Error('claimDueOutboxEvents returned no row');
  if (!row.claimed_at) throw new Error('claimed event has no claimed_at');
  return { row, claimToken: row.claimed_at };
}

describe('analytics outbox (integration)', () => {
  beforeEach(async () => {
    await db.delete(analytics_event_outbox).where(sql`true`);
    await db.delete(operation_ledgers).where(sql`true`);
  });

  afterAll(async () => {
    await db.delete(analytics_event_outbox).where(sql`true`);
    await db.delete(operation_ledgers).where(sql`true`);
  });

  it('claims only due pending rows, oldest first, and marks them sending', async () => {
    const future = new Date(Date.now() + HOUR_MS).toISOString();
    const past = new Date(Date.now() - HOUR_MS).toISOString();
    const [firstDue, secondDue, notDue] = await db
      .insert(analytics_event_outbox)
      .values([
        {
          event_uuid: randomUUID(),
          event_name: 'session_create_settled',
          distinct_id: 'user@example.com',
          properties: { source: 'server' },
          created_at: past,
        },
        {
          event_uuid: randomUUID(),
          event_name: 'session_create_settled',
          distinct_id: 'user@example.com',
          properties: { source: 'server' },
          created_at: new Date().toISOString(),
        },
        {
          event_uuid: randomUUID(),
          event_name: 'session_create_settled',
          distinct_id: 'user@example.com',
          properties: { source: 'server' },
          next_attempt_at: future,
        },
      ])
      .returning();
    if (!firstDue || !secondDue || !notDue) throw new Error('Outbox fixture insert failed');

    const claimed = await claimDueOutboxEvents(db, 10);
    expect(claimed.map(r => r.id).sort()).toEqual([firstDue.id, secondDue.id].sort());
    for (const row of claimed) {
      expect(row.status).toBe('sending');
      expect(row.claimed_at).not.toBeNull();
    }

    const [stillPending] = await db
      .select()
      .from(analytics_event_outbox)
      .where(eq(analytics_event_outbox.id, notDue.id));
    expect(stillPending?.status).toBe('pending');
  });

  it('respects the claim batch limit', async () => {
    await insertOutboxRow();
    await insertOutboxRow();

    const claimed = await claimDueOutboxEvents(db, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.status).toBe('sending');

    const pending = await db
      .select()
      .from(analytics_event_outbox)
      .where(eq(analytics_event_outbox.status, 'pending'));
    expect(pending).toHaveLength(1);
  });

  it('marks a claimed event delivered and clears the claim and retry clock', async () => {
    const inserted = await insertOutboxRow();
    const { claimToken } = await claimFirstEvent();

    const delivered = await markOutboxDelivered(db, {
      eventId: inserted.id,
      claimedAt: claimToken,
    });
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.delivered_at).not.toBeNull();
    expect(delivered?.claimed_at).toBeNull();
    expect(delivered?.next_attempt_at).toBeNull();
  });

  it('requeues a failed send with backoff and records the error', async () => {
    const inserted = await insertOutboxRow();
    const { claimToken } = await claimFirstEvent();

    const result = await markOutboxRetry(db, {
      eventId: inserted.id,
      claimedAt: claimToken,
      error: 'posthog 500',
    });
    expect(result?.outcome).toBe('retried');
    if (result?.outcome !== 'retried') return;
    expect(result.row.status).toBe('pending');
    expect(result.row.attempts).toBe(1);
    expect(result.row.last_error).toBe('posthog 500');
    expect(result.row.claimed_at).toBeNull();
    expect(result.row.next_attempt_at).not.toBeNull();
    // The first retry waits the 60-second initial backoff, not 120s (P2-A-04 regression).
    const firstDelayMs = new Date(result.row.next_attempt_at as string).getTime() - Date.now();
    expect(firstDelayMs).toBeGreaterThan(OUTBOX_INITIAL_RETRY_BACKOFF_MS - 5_000);
    expect(firstDelayMs).toBeLessThan(OUTBOX_INITIAL_RETRY_BACKOFF_MS + 5_000);
  });

  it('doubles the retry backoff on each later attempt and caps it at one hour', async () => {
    // Second retry (old attempts = 1) waits 60s * 2^1 = 120s.
    const secondRetry = await insertOutboxRow({ attempts: 1 });
    const secondClaim = await claimFirstEvent();
    const secondResult = await markOutboxRetry(db, {
      eventId: secondRetry.id,
      claimedAt: secondClaim.claimToken,
    });
    expect(secondResult?.outcome).toBe('retried');
    if (secondResult?.outcome !== 'retried') return;
    const secondDelayMs =
      new Date(secondResult.row.next_attempt_at as string).getTime() - Date.now();
    expect(secondDelayMs).toBeGreaterThan(2 * OUTBOX_INITIAL_RETRY_BACKOFF_MS - 5_000);
    expect(secondDelayMs).toBeLessThan(2 * OUTBOX_INITIAL_RETRY_BACKOFF_MS + 5_000);

    // Attempt 7 (old attempts = 6) would be 60s * 2^6 = 64min, so it caps at 60min.
    const cappedRetry = await insertOutboxRow({ attempts: 6 });
    const cappedClaim = await claimFirstEvent();
    const cappedResult = await markOutboxRetry(db, {
      eventId: cappedRetry.id,
      claimedAt: cappedClaim.claimToken,
    });
    expect(cappedResult?.outcome).toBe('retried');
    if (cappedResult?.outcome !== 'retried') return;
    const cappedDelayMs =
      new Date(cappedResult.row.next_attempt_at as string).getTime() - Date.now();
    expect(cappedDelayMs).toBeGreaterThan(OUTBOX_MAX_RETRY_BACKOFF_MS - 5_000);
    expect(cappedDelayMs).toBeLessThan(OUTBOX_MAX_RETRY_BACKOFF_MS + 5_000);
  });

  it('fails a row terminally when retries reach the attempt cap', async () => {
    const inserted = await insertOutboxRow({ attempts: OUTBOX_MAX_ATTEMPTS - 1 });
    const { claimToken } = await claimFirstEvent();

    const result = await markOutboxRetry(db, {
      eventId: inserted.id,
      claimedAt: claimToken,
      error: 'final failure',
    });
    expect(result?.outcome).toBe('failed');
    if (result?.outcome !== 'failed') return;
    expect(result.row.status).toBe('failed');
    expect(result.row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(result.row.next_attempt_at).toBeNull();
  });

  it('force-fails a claimed event for a definitive send error', async () => {
    const inserted = await insertOutboxRow();
    const { claimToken } = await claimFirstEvent();

    const failed = await markOutboxFailed(db, {
      eventId: inserted.id,
      claimedAt: claimToken,
      error: 'invalid payload',
    });
    expect(failed?.status).toBe('failed');
    expect(failed?.attempts).toBe(1);
    expect(failed?.claimed_at).toBeNull();
    expect(failed?.last_error).toBe('invalid payload');
  });

  it('ignores late old-sender marks after a stale reclaim and re-claim', async () => {
    const inserted = await insertOutboxRow();
    const { claimToken: oldClaimToken } = await claimFirstEvent();

    // Age the first claim past the stale window and reclaim it.
    await db
      .update(analytics_event_outbox)
      .set({ claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() })
      .where(eq(analytics_event_outbox.id, inserted.id));
    const reclaimed = await reclaimStaleSendingEvents(db);
    expect(reclaimed.map(r => r.id)).toContain(inserted.id);

    // A new drainer claims the event again with a fresh claim token.
    const second = await claimFirstEvent();
    expect(second.row.id).toBe(inserted.id);
    expect(second.claimToken).not.toBe(oldClaimToken);

    // The old sender's late marks must not touch the new sending claim.
    expect(
      await markOutboxDelivered(db, { eventId: inserted.id, claimedAt: oldClaimToken })
    ).toBeNull();
    expect(
      await markOutboxFailed(db, { eventId: inserted.id, claimedAt: oldClaimToken, error: 'late' })
    ).toBeNull();
    expect(
      await markOutboxRetry(db, { eventId: inserted.id, claimedAt: oldClaimToken, error: 'late' })
    ).toBeNull();

    const [row] = await db
      .select()
      .from(analytics_event_outbox)
      .where(eq(analytics_event_outbox.id, inserted.id));
    expect(row?.status).toBe('sending');
    expect(row?.claimed_at).toBe(second.claimToken);
    expect(row?.attempts).toBe(0);
  });

  it('does not overwrite a delivered terminal state with a late mark', async () => {
    const inserted = await insertOutboxRow();
    const { claimToken } = await claimFirstEvent();

    const delivered = await markOutboxDelivered(db, {
      eventId: inserted.id,
      claimedAt: claimToken,
    });
    expect(delivered?.status).toBe('delivered');

    // Replayed marks from the now-finished sender are all no-ops.
    expect(
      await markOutboxDelivered(db, { eventId: inserted.id, claimedAt: claimToken })
    ).toBeNull();
    expect(await markOutboxRetry(db, { eventId: inserted.id, claimedAt: claimToken })).toBeNull();
    expect(await markOutboxFailed(db, { eventId: inserted.id, claimedAt: claimToken })).toBeNull();

    const [row] = await db
      .select()
      .from(analytics_event_outbox)
      .where(eq(analytics_event_outbox.id, inserted.id));
    expect(row?.status).toBe('delivered');
    expect(row?.attempts).toBe(0);
  });

  it('reclaims only sending rows whose claim is older than the stale window', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const [staleRow, freshRow] = await db
      .insert(analytics_event_outbox)
      .values([
        {
          event_uuid: randomUUID(),
          event_name: 'session_create_settled',
          distinct_id: 'user@example.com',
          properties: { source: 'server' },
          status: 'sending',
          claimed_at: stale,
        },
        {
          event_uuid: randomUUID(),
          event_name: 'session_create_settled',
          distinct_id: 'user@example.com',
          properties: { source: 'server' },
          status: 'sending',
          claimed_at: recent,
        },
      ])
      .returning();
    if (!staleRow || !freshRow) throw new Error('Outbox fixture insert failed');

    const reclaimed = await reclaimStaleSendingEvents(db);
    expect(reclaimed.map(r => r.id)).toContain(staleRow.id);
    expect(reclaimed.map(r => r.id)).not.toContain(freshRow.id);

    const [afterStale, afterFresh] = await Promise.all([
      db.select().from(analytics_event_outbox).where(eq(analytics_event_outbox.id, staleRow.id)),
      db.select().from(analytics_event_outbox).where(eq(analytics_event_outbox.id, freshRow.id)),
    ]);
    expect(afterStale[0]?.status).toBe('pending');
    expect(afterStale[0]?.claimed_at).toBeNull();
    expect(afterFresh[0]?.status).toBe('sending');
  });

  it('purges delivered rows after 7 days and failed rows after 30 days', async () => {
    const oldDelivered = await insertOutboxRow({
      status: 'delivered',
      delivered_at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    });
    const recentDelivered = await insertOutboxRow({
      status: 'delivered',
      delivered_at: new Date().toISOString(),
    });
    const oldFailed = await insertOutboxRow({
      status: 'failed',
      created_at: new Date(Date.now() - 31 * DAY_MS).toISOString(),
    });
    const recentFailed = await insertOutboxRow({ status: 'failed' });

    const result = await purgeExpired(db);
    expect(result.outboxDeliveredPurged).toBe(1);
    expect(result.outboxFailedPurged).toBe(1);

    expect(
      await db
        .select()
        .from(analytics_event_outbox)
        .where(eq(analytics_event_outbox.id, oldDelivered.id))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(analytics_event_outbox)
        .where(eq(analytics_event_outbox.id, recentDelivered.id))
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(analytics_event_outbox)
        .where(eq(analytics_event_outbox.id, oldFailed.id))
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(analytics_event_outbox)
        .where(eq(analytics_event_outbox.id, recentFailed.id))
    ).toHaveLength(1);
  });

  it('settles expired non-terminal ledger rows as failed with expired_unsettled', async () => {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + HOUR_MS).toISOString();
    const expiredAt = new Date(now.getTime() - DAY_MS).toISOString();
    const futureExpiresAt = new Date(now.getTime() + DAY_MS).toISOString();

    const [expiredAdmitted, expiredReconcile, future] = await db
      .insert(operation_ledgers)
      .values([
        {
          operation_key: 'expired-admitted',
          domain: 'session',
          intent: 'create',
          kilo_user_id: 'backstop-user',
          taxonomy: 'safe-retry',
          status: 'admitted',
          lease_expires_at: leaseExpiresAt,
          expires_at: expiredAt,
        },
        {
          operation_key: 'expired-reconcile',
          domain: 'session',
          intent: 'create',
          kilo_user_id: 'backstop-user',
          taxonomy: 'safe-retry',
          status: 'reconcile_pending',
          lease_expires_at: leaseExpiresAt,
          expires_at: expiredAt,
        },
        {
          operation_key: 'future',
          domain: 'session',
          intent: 'create',
          kilo_user_id: 'backstop-user',
          taxonomy: 'safe-retry',
          status: 'admitted',
          lease_expires_at: leaseExpiresAt,
          expires_at: futureExpiresAt,
        },
      ])
      .returning();
    if (!expiredAdmitted || !expiredReconcile || !future) {
      throw new Error('Ledger fixture insert failed');
    }

    const result = await purgeExpired(db);
    expect(result.expiredUnsettledLedgerSettled).toBe(2);

    const [settledAdmitted, settledReconcile, untouched] = await Promise.all([
      db.select().from(operation_ledgers).where(eq(operation_ledgers.id, expiredAdmitted.id)),
      db.select().from(operation_ledgers).where(eq(operation_ledgers.id, expiredReconcile.id)),
      db.select().from(operation_ledgers).where(eq(operation_ledgers.id, future.id)),
    ]);
    expect(settledAdmitted[0]?.status).toBe('failed');
    expect(settledAdmitted[0]?.outcome_code).toBe(EXPIRED_UNSETTLED_OUTCOME_CODE);
    expect(settledAdmitted[0]?.settled_at).not.toBeNull();
    expect(settledReconcile[0]?.status).toBe('failed');
    expect(settledReconcile[0]?.outcome_code).toBe(EXPIRED_UNSETTLED_OUTCOME_CODE);
    expect(untouched[0]?.status).toBe('admitted');
  });

  it('does not settle terminal ledger rows in the backstop', async () => {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + HOUR_MS).toISOString();
    const expiredAt = new Date(now.getTime() - DAY_MS).toISOString();

    const [terminal] = await db
      .insert(operation_ledgers)
      .values({
        operation_key: 'already-settled',
        domain: 'session',
        intent: 'create',
        kilo_user_id: 'backstop-user',
        taxonomy: 'safe-retry',
        status: 'completed',
        outcome_code: 'ok',
        settled_at: new Date(now.getTime() - HOUR_MS).toISOString(),
        lease_expires_at: leaseExpiresAt,
        expires_at: expiredAt,
      })
      .returning();
    if (!terminal) throw new Error('Ledger fixture insert failed');

    const result = await purgeExpired(db);
    expect(result.expiredUnsettledLedgerSettled).toBe(0);

    const [row] = await db
      .select()
      .from(operation_ledgers)
      .where(eq(operation_ledgers.id, terminal.id));
    expect(row?.status).toBe('completed');
  });
});
