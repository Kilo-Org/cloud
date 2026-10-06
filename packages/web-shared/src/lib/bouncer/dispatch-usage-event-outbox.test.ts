/**
 * Integration tests for the Bouncer usage-event outbox delivery: it runs against the real test
 * database and only the HTTP transport is stubbed, so the assertions observe real row transitions.
 */
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';

import {
  deliverBouncerUsageEventNow,
  dispatchQueuedBouncerUsageEvents,
} from '@kilocode/web-shared/lib/bouncer/dispatch-usage-event-outbox';
import { deliverUsageEventWireBody } from '@kilocode/web-shared/lib/bouncer/client';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { bouncer_usage_event_outbox } from '@kilocode/db/schema';

jest.mock('@kilocode/web-shared/lib/bouncer/client', () => ({
  __esModule: true,
  deliverUsageEventWireBody: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

const mockDeliver = jest.mocked(deliverUsageEventWireBody);

async function insertPending(userId: string, requestId = randomUUID()) {
  await db.insert(bouncer_usage_event_outbox).values({
    request_id: requestId,
    user_id: userId,
    payload: { requestId, accountId: `user:${userId}`, inputTokens: 1, outputTokens: 1 },
  });
  return requestId;
}

async function rowFor(requestId: string) {
  const [row] = await db
    .select()
    .from(bouncer_usage_event_outbox)
    .where(eq(bouncer_usage_event_outbox.request_id, requestId));
  return row;
}

describe('bouncer usage-event outbox delivery', () => {
  beforeEach(async () => {
    await db.delete(bouncer_usage_event_outbox).where(sql`true`);
    mockDeliver.mockReset();
  });

  afterAll(async () => {
    await db.delete(bouncer_usage_event_outbox).where(sql`true`);
  });

  it('delivers the enqueued row immediately and reports it as queued', async () => {
    const user = await insertTestUser();
    const requestId = await insertPending(user.id);
    mockDeliver.mockResolvedValue({ delivered: true, status: 204 });

    await expect(deliverBouncerUsageEventNow(requestId)).resolves.toBe(true);

    expect((await rowFor(requestId))?.status).toBe('delivered');
    expect(mockDeliver).toHaveBeenCalledWith(expect.objectContaining({ requestId }));
  });

  it('reports no row so the caller falls back to the best-effort send', async () => {
    await expect(deliverBouncerUsageEventNow('req-never-enqueued')).resolves.toBe(false);
    expect(mockDeliver).not.toHaveBeenCalled();
  });

  it('leaves a failed immediate delivery to the cron drainer, which retries it', async () => {
    const user = await insertTestUser();
    const requestId = await insertPending(user.id);
    mockDeliver.mockResolvedValueOnce({
      delivered: false,
      permanent: false,
      status: 503,
      error: 'http_503',
    });

    await expect(deliverBouncerUsageEventNow(requestId)).resolves.toBe(true);
    const retried = await rowFor(requestId);
    expect(retried?.status).toBe('pending');
    expect(retried?.attempts).toBe(1);

    // Make the backoff due, as the next cron pass after the delay would see it.
    await db
      .update(bouncer_usage_event_outbox)
      .set({ next_attempt_at: null })
      .where(eq(bouncer_usage_event_outbox.request_id, requestId));
    mockDeliver.mockResolvedValueOnce({ delivered: true, status: 204 });

    const summary = await dispatchQueuedBouncerUsageEvents({ limit: 10 });

    expect(summary.delivered).toBe(1);
    expect((await rowFor(requestId))?.status).toBe('delivered');
  });
});
