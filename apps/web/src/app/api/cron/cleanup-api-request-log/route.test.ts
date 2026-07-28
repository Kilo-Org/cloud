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

import { api_request_compress_log, api_request_log } from '@kilocode/db/schema';
import { db, sql } from '@/lib/drizzle';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

const BATCH_SIZE = 1_000;

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

async function insertApiRequestCompressLogRecord(created_at: string) {
  const [row] = await db
    .insert(api_request_compress_log)
    .values({
      created_at,
      kilo_user_id: 'test-user',
      provider: 'test-provider',
      model: 'test-model',
      request: {},
      result: {},
    })
    .returning();
  return row;
}

describe('GET /api/cron/cleanup-api-request-log', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await db.delete(api_request_log).where(sql`true`);
    await db.delete(api_request_compress_log).where(sql`true`);
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
      deleted_api_request_compress_log_count: 0,
      deleted_count: 0,
      batch_size: BATCH_SIZE,
      has_more: false,
    });
  });

  it('deletes expired records and preserves recent records', async () => {
    await insertApiRequestLogRecord(daysAgo(45));
    await insertApiRequestLogRecord(daysAgo(31));
    const recent = await insertApiRequestLogRecord(daysAgo(1));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(2);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'succeeded',
        deleted_api_request_log_count: 2,
        deleted_api_request_compress_log_count: 0,
        deleted_count: 2,
      })
    );

    const remaining = await db.select().from(api_request_log);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(recent.id);
  });

  it('deletes expired compression records and preserves recent records', async () => {
    await insertApiRequestCompressLogRecord(daysAgo(45));
    await insertApiRequestCompressLogRecord(daysAgo(31));
    const recent = await insertApiRequestCompressLogRecord(daysAgo(1));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(2);
    expect(body.hasMore).toBe(false);

    const remaining = await db.select().from(api_request_compress_log);
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
