import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

import { api_request_log } from '@kilocode/db/schema';
import { db, sql } from '@/lib/drizzle';
import { GET } from './route';

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

describe('GET /api/cron/cleanup-api-request-log', () => {
  beforeEach(async () => {
    await db.delete(api_request_log).where(sql`true`);
  });

  it('rejects requests without authorization header', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
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
});
