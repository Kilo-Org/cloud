import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn((_run, error) => ({
    outcome: 'failed',
    exception_name: error instanceof Error ? error.name : 'UnknownError',
  })),
  emitScheduledJobEvent: jest.fn(),
}));

import { api_request_log, api_request_log_payload_deletions } from '@kilocode/db/schema';
import { db, sql } from '@/lib/drizzle';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';
import { deleteApiRequestLogPayloads } from '@/lib/r2/api-request-logs';

jest.mock('@/lib/r2/api-request-logs', () => ({
  deleteApiRequestLogPayloads: jest.fn(),
}));

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const mockDeleteApiRequestLogPayloads = jest.mocked(deleteApiRequestLogPayloads);

const BATCH_SIZE = 10_000;

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-api-request-log', {
    method: 'GET',
    headers,
  });
}

async function insertApiRequestLogRecord(created_at: string, provider = 'test-provider') {
  const [row] = await db.insert(api_request_log).values({ created_at, provider }).returning();
  return row;
}

async function insertApiRequestLogRecords(count: number, created_at: string) {
  await db.insert(api_request_log).values(
    Array.from({ length: count }, (_, index) => ({
      created_at,
      provider: `test-provider-${index}`,
    }))
  );
}

describe('GET /api/cron/cleanup-api-request-log', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockDeleteApiRequestLogPayloads.mockImplementation(async keys => ({
      deletedKeys: keys,
      failedKeys: [],
    }));
    await db.delete(api_request_log).where(sql`true`);
    await db.delete(api_request_log_payload_deletions).where(sql`true`);
  });

  it('rejects requests without authorization header', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
  });

  it('returns zero deleted when table is empty', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(0);
    expect(body.batchSize).toBe(BATCH_SIZE);
    expect(body.hasMore).toBe(false);
    expect(body.cutoffDate).toEqual(expect.any(String));
    expect(body.timestamp).toEqual(expect.any(String));
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      deleted_api_request_log_count: 0,
      deleted_count: 0,
      queued_payload_count: 0,
      deleted_payload_count: 0,
      batch_size: BATCH_SIZE,
      has_more: false,
    });
  });

  it('deletes records older than seven days and preserves recent records', async () => {
    await insertApiRequestLogRecord(daysAgo(45));
    await insertApiRequestLogRecord(daysAgo(8));
    const recent = await insertApiRequestLogRecord(daysAgo(6));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(2);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'succeeded',
        deleted_api_request_log_count: 2,
        deleted_count: 2,
      })
    );

    const remaining = await db.select().from(api_request_log);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(recent.id);
  });

  it('deletes at most one batch per request', async () => {
    await insertApiRequestLogRecords(BATCH_SIZE + 5, daysAgo(45));
    const recent1 = await insertApiRequestLogRecord(daysAgo(1), 'recent-1');
    const recent2 = await insertApiRequestLogRecord(new Date().toISOString(), 'recent-2');

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(BATCH_SIZE);
    expect(body.batchSize).toBe(BATCH_SIZE);
    expect(body.hasMore).toBe(true);

    const remaining = await db.select().from(api_request_log);
    expect(remaining).toHaveLength(7);

    const remainingIds = remaining.map(row => row.id.toString()).sort();
    expect(remainingIds).toEqual(
      expect.arrayContaining([recent1.id.toString(), recent2.id.toString()])
    );
  });

  it('queues and deletes R2 payloads while expiring their metadata rows', async () => {
    const expired = await db
      .insert(api_request_log)
      .values({
        created_at: daysAgo(8),
        provider: 'object-backed',
        payload_object_key: 'api-request-logs/v1/payload.json.gz',
      })
      .returning();

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    expect(mockDeleteApiRequestLogPayloads).toHaveBeenCalledWith([
      'api-request-logs/v1/payload.json.gz',
    ]);
    await expect(
      db
        .select()
        .from(api_request_log)
        .where(sql`${api_request_log.id} = ${expired[0].id}`)
    ).resolves.toHaveLength(0);
    await expect(db.select().from(api_request_log_payload_deletions)).resolves.toHaveLength(0);
  });

  it('keeps deletion work queued when R2 deletion fails', async () => {
    const expired = await db
      .insert(api_request_log)
      .values({
        created_at: daysAgo(8),
        provider: 'object-backed',
        payload_object_key: 'api-request-logs/v1/payload.json.gz',
      })
      .returning();
    mockDeleteApiRequestLogPayloads.mockResolvedValue({
      deletedKeys: [],
      failedKeys: ['api-request-logs/v1/payload.json.gz'],
    });

    await expect(GET(makeRequest({ authorization: 'Bearer cron-secret' }))).rejects.toThrow(
      'Failed to delete 1 API request log payloads'
    );
    await expect(
      db
        .select()
        .from(api_request_log)
        .where(sql`${api_request_log.id} = ${expired[0].id}`)
    ).resolves.toHaveLength(0);
    await expect(db.select().from(api_request_log_payload_deletions)).resolves.toEqual([
      expect.objectContaining({ object_key: 'api-request-logs/v1/payload.json.gz' }),
    ]);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });

  it('acknowledges successful object deletions while retaining failed keys', async () => {
    await db
      .insert(api_request_log_payload_deletions)
      .values([
        { object_key: 'api-request-logs/v1/deleted.json.gz' },
        { object_key: 'api-request-logs/v1/failed.json.gz' },
      ]);
    mockDeleteApiRequestLogPayloads.mockResolvedValue({
      deletedKeys: ['api-request-logs/v1/deleted.json.gz'],
      failedKeys: ['api-request-logs/v1/failed.json.gz'],
    });

    await expect(GET(makeRequest({ authorization: 'Bearer cron-secret' }))).rejects.toThrow(
      'Failed to delete 1 API request log payloads'
    );

    await expect(db.select().from(api_request_log_payload_deletions)).resolves.toEqual([
      expect.objectContaining({ object_key: 'api-request-logs/v1/failed.json.gz' }),
    ]);
  });

  it('processes more than one R2 API batch from the deletion outbox', async () => {
    const objectKeys = Array.from(
      { length: 1_001 },
      (_, index) => `api-request-logs/v1/${index}.json.gz`
    );
    await db
      .insert(api_request_log_payload_deletions)
      .values(objectKeys.map(object_key => ({ object_key })));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const deletedKeys = mockDeleteApiRequestLogPayloads.mock.calls[0]?.[0];
    expect(deletedKeys).toHaveLength(objectKeys.length);
    expect(deletedKeys).toEqual(expect.arrayContaining(objectKeys));
    await expect(db.select().from(api_request_log_payload_deletions)).resolves.toHaveLength(0);
  });

  it('emits one failure event and preserves rejected database failure semantics', async () => {
    const select = jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    await expect(GET(makeRequest({ authorization: 'Bearer cron-secret' }))).rejects.toThrow(
      'database unavailable'
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });

    select.mockRestore();
  });
});
