import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
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

import { ai_gateway_request_logging_opt_ins, api_request_log_2 } from '@kilocode/db/schema';
import { getRequestLoggingOptIns } from '@kilocode/web-shared/lib/ai-gateway/request-logging-opt-ins';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

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

function logRecord(created_at: string) {
  return {
    id: crypto.randomUUID(),
    created_at,
    kilo_user_id: 'cleanup-test-user',
    requested_model: 'test/model',
  };
}

async function insertApiRequestLogRecord(created_at: string) {
  const [row] = await db.insert(api_request_log_2).values(logRecord(created_at)).returning();
  return row;
}

async function insertApiRequestLogRecords(count: number, created_at: string) {
  await db
    .insert(api_request_log_2)
    .values(Array.from({ length: count }, () => logRecord(created_at)));
}

describe('GET /api/cron/cleanup-api-request-log', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await db.delete(api_request_log_2).where(sql`true`);
    await db.delete(ai_gateway_request_logging_opt_ins).where(sql`true`);
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
    expect(body.deletedOptInCount).toBe(0);
    expect(body.batchSize).toBe(BATCH_SIZE);
    expect(body.hasMore).toBe(false);
    expect(body.cutoffDate).toEqual(expect.any(String));
    expect(body.timestamp).toEqual(expect.any(String));
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      deleted_api_request_log_count: 0,
      deleted_request_logging_opt_in_count: 0,
      deleted_count: 0,
      batch_size: BATCH_SIZE,
      has_more: false,
    });
  });

  it('deletes expired opt-ins while preserving future and non-expiring rules', async () => {
    const makeOptIn = (expires_at?: string) => ({
      id: crypto.randomUUID(),
      target_type: 'account' as const,
      target_id: `oauth/cleanup/${crypto.randomUUID()}`,
      reason: 'Investigate errors',
      added_by_email: 'admin@example.com',
      added_at: '2020-01-01T00:00:00.000Z',
      errors_only: true,
      ...(expires_at ? { expires_at } : {}),
    });
    const now = Date.now();
    const rules = [
      makeOptIn(new Date(now - 1).toISOString()),
      makeOptIn(new Date(now).toISOString()),
      makeOptIn(new Date(now + 60_000).toISOString()),
      makeOptIn(),
    ];
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: rules });

    const unauthorized = await GET(makeRequest());
    expect(unauthorized.status).toBe(401);
    expect(await getRequestLoggingOptIns()).toEqual(rules);

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deletedCount: 0, deletedOptInCount: 2 });
    expect(await getRequestLoggingOptIns()).toEqual(rules.slice(2));
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_request_logging_opt_in_count: 2 })
    );
  });

  it('deletes records older than thirty days and preserves recent records', async () => {
    await insertApiRequestLogRecord(daysAgo(45));
    await insertApiRequestLogRecord(daysAgo(31));
    const recent = await insertApiRequestLogRecord(daysAgo(29));

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

    const remaining = await db.select().from(api_request_log_2);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(recent.id);
  });

  it('still enforces log retention when persisted opt-in state cannot be parsed', async () => {
    await insertApiRequestLogRecord(daysAgo(45));
    const recent = await insertApiRequestLogRecord(daysAgo(1));
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: [{ id: 'invalid' }] });

    await expect(GET(makeRequest({ authorization: 'Bearer cron-secret' }))).rejects.toThrow();

    const remaining = await db.select({ id: api_request_log_2.id }).from(api_request_log_2);
    expect(remaining).toEqual([{ id: recent.id }]);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'ZodError',
    });
  });

  it('deletes at most one batch per request', async () => {
    await insertApiRequestLogRecords(BATCH_SIZE + 5, daysAgo(45));
    const recent1 = await insertApiRequestLogRecord(daysAgo(1));
    const recent2 = await insertApiRequestLogRecord(new Date().toISOString());

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(BATCH_SIZE);
    expect(body.batchSize).toBe(BATCH_SIZE);
    expect(body.hasMore).toBe(true);

    const remaining = await db.select().from(api_request_log_2);
    expect(remaining).toHaveLength(7);

    const remainingIds = remaining.map(row => row.id).sort();
    expect(remainingIds).toEqual(expect.arrayContaining([recent1.id, recent2.id]));
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
