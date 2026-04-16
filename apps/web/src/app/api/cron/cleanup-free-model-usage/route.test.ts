import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({
  CRON_SECRET: 'cron-secret',
}));

import { db, sql } from '@/lib/drizzle';
import { free_model_usage } from '@kilocode/db/schema';
import { GET } from './route';

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-free-model-usage', {
    method: 'GET',
    headers,
  });
}

async function insertUsageRecord(created_at: string, model = 'test-model', ip = '127.0.0.1') {
  const [row] = await db
    .insert(free_model_usage)
    .values({ ip_address: ip, model, created_at })
    .returning();
  return row;
}

describe('GET /api/cron/cleanup-free-model-usage', () => {
  beforeEach(async () => {
    await db.delete(free_model_usage).where(sql`true`);
  });

  it('rejects requests without authorization header', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('rejects requests with wrong authorization header', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer wrong-secret' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('returns zero deleted when table is empty', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(0);
    expect(body.iterations).toBe(1);
    expect(body.cutoffDate).toEqual(expect.any(String));
    expect(body.timestamp).toEqual(expect.any(String));
  });

  it('deletes records older than 7 days', async () => {
    await insertUsageRecord(daysAgo(10));
    await insertUsageRecord(daysAgo(8));
    await insertUsageRecord(daysAgo(14));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(3);

    const remaining = await db.select().from(free_model_usage);
    expect(remaining).toHaveLength(0);
  });

  it('preserves records newer than 7 days', async () => {
    await insertUsageRecord(daysAgo(1));
    await insertUsageRecord(daysAgo(3));
    await insertUsageRecord(new Date().toISOString());

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(0);

    const remaining = await db.select().from(free_model_usage);
    expect(remaining).toHaveLength(3);
  });

  it('deletes only expired records and preserves recent ones', async () => {
    await insertUsageRecord(daysAgo(10));
    await insertUsageRecord(daysAgo(30));
    const recent1 = await insertUsageRecord(daysAgo(1));
    const recent2 = await insertUsageRecord(daysAgo(5));
    const recent3 = await insertUsageRecord(new Date().toISOString());

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(2);

    const remaining = await db.select().from(free_model_usage);
    expect(remaining).toHaveLength(3);

    const remainingIds = remaining.map(r => r.id).sort();
    const expectedIds = [recent1.id, recent2.id, recent3.id].sort();
    expect(remainingIds).toEqual(expectedIds);
  });

  it('does not delete records right at the 7-day boundary', async () => {
    // Record created exactly 6 days and 23 hours ago should be preserved
    const almostExpired = await insertUsageRecord(daysAgo(6));
    // Record created 7+ days ago should be deleted
    await insertUsageRecord(daysAgo(8));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletedCount).toBe(1);

    const remaining = await db.select().from(free_model_usage);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(almostExpired.id);
  });
});
