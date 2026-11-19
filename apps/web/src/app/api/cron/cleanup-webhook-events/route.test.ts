import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn((_run, error) => ({
    outcome: 'failed',
    exception_name: error instanceof Error ? error.name : 'UnknownError',
  })),
  emitScheduledJobEvent: jest.fn(),
}));

import { webhook_event_signatures, webhook_events } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import {
  provisionWebhookEventPartitions,
  webhookEventPartitionName,
} from '@/lib/integrations/db/webhook-event-partitions';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET, maxDuration } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const BATCH_SIZE = 2_500;
const MAX_BATCHES_PER_RUN = 2;

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

  it('exports maxDuration of 300 seconds', () => {
    expect(maxDuration).toBe(300);
  });

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
      [61, 59].map((age, index) => ({
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

  it('drains a second batch when the first reports more expired events', async () => {
    const user = await insertTestUser();
    await db.insert(webhook_events).values(
      Array.from({ length: BATCH_SIZE + 1 }, (_, index) => ({
        owned_by_user_id: user.id,
        platform: 'github',
        event_type: 'push',
        payload: {},
        headers: {},
        event_signature: `cleanup-batch-${index}`,
        created_at: daysAgo(61),
      }))
    );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(BATCH_SIZE + 1);
    expect(body.batchesRun).toBe(2);
    expect(body.hasMore).toBe(false);
    const remaining = await db.select({ id: webhook_events.id }).from(webhook_events);
    expect(remaining).toHaveLength(0);
  });

  it('caps deletion at MAX_BATCHES_PER_RUN batches and reports remaining expired events', async () => {
    const user = await insertTestUser();
    await db.insert(webhook_events).values(
      Array.from({ length: BATCH_SIZE * MAX_BATCHES_PER_RUN + 1 }, (_, index) => ({
        owned_by_user_id: user.id,
        platform: 'github',
        event_type: 'push',
        payload: {},
        headers: {},
        event_signature: `cleanup-max-${index}`,
        created_at: daysAgo(61),
      }))
    );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(BATCH_SIZE * MAX_BATCHES_PER_RUN);
    expect(body.batchesRun).toBe(MAX_BATCHES_PER_RUN);
    expect(body.hasMore).toBe(true);
    const remaining = await db.select({ id: webhook_events.id }).from(webhook_events);
    expect(remaining).toHaveLength(1);
  });

  it('keeps the partitioned table writable, drops expired partitions and prunes signatures', async () => {
    // A day in 2020 is far past retention, so this run must detach and drop it.
    await provisionWebhookEventPartitions(db, new Date('2020-01-10T00:00:00.000Z'));
    await db.insert(webhook_event_signatures).values(
      [61, 1].map(age => ({
        event_signature: `cron-signature-${age}`,
        webhook_event_id: crypto.randomUUID(),
        webhook_event_created_at: daysAgo(age),
        created_at: daysAgo(age),
      }))
    );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.partitionErrors).toEqual([]);
    expect(body.partitionsDropped).toContain('webhook_events_v2_2020_01_10');
    expect(body.signaturesDeleted).toBe(1);
    const { rows } = await db.execute<{ name: string }>(sql`
      SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'public.webhook_events_v2'::regclass
    `);
    const names = rows.map(row => row.name);
    expect(names.some(name => name.includes('_2020_'))).toBe(false);
    expect(names).toContain(webhookEventPartitionName(new Date()));
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded', deleted_signature_count: 1 })
    );
  });

  it('fails the run when a coming partition cannot be created', async () => {
    const lastDay = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const blocked = webhookEventPartitionName(lastDay);
    await provisionWebhookEventPartitions(db);
    // Stand-in for the furthest day: a plain table that holds its name.
    await db.execute(sql.raw(`ALTER TABLE webhook_events_v2 DETACH PARTITION ${blocked}`));
    await db.execute(sql.raw(`DROP TABLE ${blocked}`));
    await db.execute(sql.raw(`CREATE TABLE ${blocked} (id int)`));

    try {
      const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.partitionErrors).toEqual([
        expect.stringContaining(`${blocked} exists but is not an attached partition`),
      ]);
      expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed' })
      );
    } finally {
      await db.execute(sql.raw(`DROP TABLE IF EXISTS ${blocked}`));
      await provisionWebhookEventPartitions(db);
    }
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
