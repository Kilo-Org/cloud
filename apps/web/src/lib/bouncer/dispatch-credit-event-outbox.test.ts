/**
 * Integration tests for the Bouncer credit-event outbox cron drainer: the drainer runs against the
 * real test database and only the HTTP transport is stubbed, so the assertions observe the actual
 * row transitions (never a mocked-enqueue passthrough).
 */
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import { dispatchQueuedBouncerCreditEvents } from '@/lib/bouncer/dispatch-credit-event-outbox';
import { deliverCreditEventWireBody } from '@/lib/bouncer/client';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { bouncer_credit_event_outbox } from '@kilocode/db/schema';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete-reasons';

jest.mock('@/lib/bouncer/client', () => ({
  __esModule: true,
  deliverCreditEventWireBody: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

const mockDeliver = jest.mocked(deliverCreditEventWireBody);

async function insertPending(
  overrides: Partial<typeof bouncer_credit_event_outbox.$inferInsert> = {}
) {
  const [row] = await db
    .insert(bouncer_credit_event_outbox)
    .values({
      event_id: randomUUID(),
      event_type: 'charge.failed',
      user_id: 'user-1',
      payload: { type: 'charge.failed', eventId: 'evt-1', userId: 'user-1' },
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('Outbox fixture insert failed');
  return row;
}

describe('dispatchQueuedBouncerCreditEvents', () => {
  beforeEach(async () => {
    await db.delete(bouncer_credit_event_outbox).where(sql`true`);
    mockDeliver.mockReset();
  });

  afterAll(async () => {
    await db.delete(bouncer_credit_event_outbox).where(sql`true`);
  });

  it('marks a row delivered only on a real HTTP success', async () => {
    const row = await insertPending();
    mockDeliver.mockResolvedValue({ delivered: true, status: 200 });

    const summary = await dispatchQueuedBouncerCreditEvents({ limit: 10 });

    expect(summary.delivered).toBe(1);
    const [after] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.id, row.id));
    expect(after?.status).toBe('delivered');
    expect(after?.delivered_at).not.toBeNull();
    expect(mockDeliver).toHaveBeenCalledWith(expect.objectContaining({ type: 'charge.failed' }));
  });

  it('never marks a row delivered when the transport reports failure', async () => {
    const row = await insertPending();
    mockDeliver.mockResolvedValue({
      delivered: false,
      permanent: false,
      status: 503,
      error: 'http_503',
    });

    const summary = await dispatchQueuedBouncerCreditEvents({ limit: 10 });

    expect(summary.retried).toBe(1);
    const [after] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.id, row.id));
    expect(after?.status).toBe('pending');
    expect(after?.attempts).toBe(1);
    expect(after?.next_attempt_at).not.toBeNull();
    expect(after?.last_error).toContain('http_503');
  });

  it('fails a row terminally on a permanent transport failure', async () => {
    const row = await insertPending();
    mockDeliver.mockResolvedValue({
      delivered: false,
      permanent: true,
      status: null,
      error: 'bouncer_not_configured',
    });

    const summary = await dispatchQueuedBouncerCreditEvents({ limit: 10 });

    expect(summary.failed).toBe(1);
    const [after] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.id, row.id));
    expect(after?.status).toBe('failed');
    expect(after?.last_error).toBe('bouncer_not_configured');
  });

  it('drops a claimed row whose owner became soft-deleted, without delivering', async () => {
    const user = await insertTestUser({ blocked_reason: createSoftDeletedBlockedReason() });
    const row = await insertPending({
      user_id: user.id,
      payload: { type: 'charge.failed', eventId: 'evt-deleted-owner', userId: user.id },
    });
    mockDeliver.mockResolvedValue({ delivered: true, status: 200 });

    const summary = await dispatchQueuedBouncerCreditEvents({ limit: 10 });

    expect(summary.failed).toBe(1);
    expect(mockDeliver).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.id, row.id));
    expect(rows).toHaveLength(0);
  });

  it('fails a row with an unvalidatable payload without calling the transport', async () => {
    const row = await insertPending({ payload: { not: 'a credit event' } });

    const summary = await dispatchQueuedBouncerCreditEvents({ limit: 10 });

    expect(summary.failed).toBe(1);
    expect(mockDeliver).not.toHaveBeenCalled();
    const [after] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.id, row.id));
    expect(after?.status).toBe('failed');
    expect(after?.last_error).toBe('invalid_payload');
  });

  it('reclaims a stale sending claim before draining', async () => {
    const row = await insertPending({
      status: 'sending',
      claimed_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    mockDeliver.mockResolvedValue({ delivered: true, status: 200 });

    const summary = await dispatchQueuedBouncerCreditEvents({ limit: 10 });

    expect(summary.reclaimed).toBe(1);
    const [after] = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.id, row.id));
    expect(after?.status).toBe('delivered');
  });

  it('respects the claim limit', async () => {
    await insertPending();
    await insertPending();
    mockDeliver.mockResolvedValue({ delivered: true, status: 200 });

    const summary = await dispatchQueuedBouncerCreditEvents({ limit: 1 });

    expect(summary.claimed).toBe(1);
    const pending = await db
      .select()
      .from(bouncer_credit_event_outbox)
      .where(eq(bouncer_credit_event_outbox.status, 'pending'));
    expect(pending).toHaveLength(1);
  });
});
