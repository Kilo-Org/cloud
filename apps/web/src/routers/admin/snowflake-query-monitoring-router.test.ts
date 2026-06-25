import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users, snowflake_query_log, type User } from '@kilocode/db/schema';
import { inArray, sql } from 'drizzle-orm';

const START_DATE = '2035-01-10T00:00:00.000Z';
const END_DATE = '2035-01-11T00:00:00.000Z';

function input(overrides: Partial<{ startDate: string; endDate: string }> = {}) {
  return { startDate: START_DATE, endDate: END_DATE, bucket: 'hour' as const, ...overrides };
}

describe('adminSnowflakeQueryMonitoringRouter', () => {
  let adminUser: User;
  let regularUser: User;

  beforeAll(async () => {
    adminUser = await insertTestUser({
      google_user_email: `admin-snowflake-monitoring-${Date.now()}@example.com`,
      is_admin: true,
    });
    regularUser = await insertTestUser({
      google_user_email: `regular-snowflake-monitoring-${Date.now()}@example.com`,
    });
  });

  beforeEach(async () => {
    await db.delete(snowflake_query_log).where(sql`true`);
  });

  afterAll(async () => {
    await db
      .delete(kilocode_users)
      .where(inArray(kilocode_users.id, [adminUser.id, regularUser.id]));
  });

  it('requires admin access and validates the retained interval', async () => {
    const regularCaller = await createCallerForUser(regularUser.id);
    const adminCaller = await createCallerForUser(adminUser.id);

    await expect(
      regularCaller.admin.snowflakeQueryMonitoring.getOverview(input())
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      adminCaller.admin.snowflakeQueryMonitoring.getOverview(
        input({ startDate: END_DATE, endDate: END_DATE })
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      adminCaller.admin.snowflakeQueryMonitoring.getOverview({
        startDate: '2035-01-01T00:00:00.000Z',
        endDate: '2035-02-01T00:00:00.001Z',
        bucket: 'day',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('aggregates logical queries, request fan-out, retries, and failures', async () => {
    await db.insert(snowflake_query_log).values([
      {
        created_at: '2035-01-10 01:10:00.000+00',
        source: 'web',
        query_label: 'usage_analytics.summary_hourly',
        request_id: '11111111-1111-4111-8111-111111111111',
        succeeded: true,
        status_code: 200,
        duration_ms: 100,
        submit_request_count: 1,
        row_count: 1,
      },
      {
        created_at: '2035-01-10 01:20:00.000+00',
        source: 'kiloclaw-billing',
        query_label: 'trial_inactivity.active_users',
        request_id: '22222222-2222-4222-8222-222222222222',
        statement_handle: 'statement-2',
        succeeded: false,
        status_code: 429,
        duration_ms: 300,
        submit_request_count: 1,
        poll_request_count: 2,
        partition_request_count: 1,
        http_202_count: 2,
        http_429_count: 1,
        retry_count: 2,
        partition_count: 3,
        error_code: 'HTTP_429',
        error_message: 'SQL API submit was rate limited',
      },
    ]);

    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.snowflakeQueryMonitoring.getOverview(input());

    expect(result.summary).toEqual({
      queryCount: 2,
      succeededQueries: 1,
      failedQueries: 1,
      failureRate: 0.5,
      averageDurationMs: 200,
      p95DurationMs: 290,
      requestCount: 5,
      retryCount: 2,
      http202Count: 2,
      http429Count: 1,
      partitionCount: 3,
    });
    expect(result.series).toHaveLength(24);
    expect(result.series[1]).toEqual({
      bucketStart: '2035-01-10T01:00:00.000Z',
      succeededQueries: 1,
      failedQueries: 1,
      averageDurationMs: 200,
      http429Count: 1,
    });
    expect(result.breakdown).toEqual([
      expect.objectContaining({
        source: 'kiloclaw-billing',
        queryLabel: 'trial_inactivity.active_users',
        queryCount: 1,
        failedQueries: 1,
        requestCount: 4,
        retryCount: 2,
        http429Count: 1,
      }),
      expect.objectContaining({
        source: 'web',
        queryLabel: 'usage_analytics.summary_hourly',
        queryCount: 1,
        failedQueries: 0,
        requestCount: 1,
      }),
    ]);
    expect(result.recentFailures).toEqual([
      expect.objectContaining({
        createdAt: '2035-01-10T01:20:00.000Z',
        source: 'kiloclaw-billing',
        statusCode: 429,
        errorCode: 'HTTP_429',
      }),
    ]);
  });

  it('returns stable empty aggregates and buckets', async () => {
    const caller = await createCallerForUser(adminUser.id);
    const result = await caller.admin.snowflakeQueryMonitoring.getOverview(input());

    expect(result.summary.queryCount).toBe(0);
    expect(result.summary.failureRate).toBe(0);
    expect(result.series).toHaveLength(24);
    expect(result.series.every(point => point.succeededQueries === 0)).toBe(true);
    expect(result.breakdown).toEqual([]);
    expect(result.recentFailures).toEqual([]);
  });
});
