import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn((_run, error) => ({
    outcome: 'failed',
    exception_name: error instanceof Error ? error.name : 'UnknownError',
  })),
  emitScheduledJobEvent: jest.fn(),
}));

import { webhook_events } from '@kilocode/db/schema';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const BATCH_SIZE = 1_000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-webhook-events', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cleanup-webhook-events', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(cleanupDbForTest);

  it('rejects requests without authorization', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
  });

  it('reports zero deletions when no events have expired', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(0);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_webhook_events_count: 0, has_more: false })
    );
  });

  it('deletes expired events and preserves recent events', async () => {
    const user = await insertTestUser();
    await db.insert(webhook_events).values(
      [8, 6].map((age, index) => ({
        owned_by_user_id: user.id,
        platform: 'github',
        event_type: 'push',
        payload: {},
        headers: {},
        event_signature: `cleanup-event-${index}`,
        created_at: daysAgo(age),
      }))
    );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(1);
    expect(body.batchSize).toBe(BATCH_SIZE);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_webhook_events_count: 1, has_more: false })
    );
    const remaining = await db.select().from(webhook_events);
    expect(remaining.map(event => event.event_signature)).toEqual(['cleanup-event-1']);
  });

  it('deletes only one batch and reports remaining expired events', async () => {
    const user = await insertTestUser();
    await db.insert(webhook_events).values(
      Array.from({ length: BATCH_SIZE + 1 }, (_, index) => ({
        owned_by_user_id: user.id,
        platform: 'github',
        event_type: 'push',
        payload: {},
        headers: {},
        event_signature: `cleanup-batch-${index}`,
        created_at: daysAgo(8),
      }))
    );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(BATCH_SIZE);
    expect(body.hasMore).toBe(true);
    const remaining = await db.select({ id: webhook_events.id }).from(webhook_events);
    expect(remaining).toHaveLength(1);
  });

  it('reports database failures without treating them as successful cleanup', async () => {
    const select = jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    try {
      await expect(GET(makeRequest({ authorization: 'Bearer cron-secret' }))).rejects.toThrow(
        'database unavailable'
      );
      expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
        outcome: 'failed',
        exception_name: 'Error',
      });
    } finally {
      select.mockRestore();
    }
  });
});
