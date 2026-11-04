import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn((_run, error) => ({
    outcome: 'failed',
    exception_name: error instanceof Error ? error.name : 'UnknownError',
  })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.setTimeout(30_000);

import { organization_permission_events_daily } from '@kilocode/db/schema';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET, maxDuration } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const BATCH_SIZE = 2_500;
const MAX_BATCHES_PER_RUN = 10;

function utcDaysAgo(days: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days))
    .toISOString()
    .slice(0, 10);
}

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-permission-events', {
    method: 'GET',
    headers,
  });
}

async function createRows(count: number, day: string) {
  const user = await insertTestUser();
  const organization = await createTestOrganization('Permission cleanup org', user.id, 0);
  const timestamp = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, index) => ({
    organization_id: organization.id,
    day,
    kilo_user_id: user.id,
    client: 'cli',
    permission: 'bash',
    command_key: `cmd-${index}`,
    decision: 'denied' as const,
    count: 1,
    first_seen_at: timestamp,
    last_seen_at: timestamp,
  }));
  for (let i = 0; i < rows.length; i += 5_000) {
    await db.insert(organization_permission_events_daily).values(rows.slice(i, i + 5_000));
  }
}

describe('GET /api/cron/cleanup-permission-events', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(cleanupDbForTest);

  it('exports maxDuration of 300 seconds', () => {
    expect(maxDuration).toBe(300);
  });

  it('rejects requests without authorization', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong secret', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer wrong' }));

    expect(response.status).toBe(401);
  });

  it('deletes days before UTC today minus 90 days and keeps the 90-day boundary', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Permission boundary org', user.id, 0);
    const timestamp = new Date().toISOString();
    await db.insert(organization_permission_events_daily).values(
      [92, 91, 90, 89].map(age => ({
        organization_id: organization.id,
        day: utcDaysAgo(age),
        kilo_user_id: user.id,
        client: 'cli',
        permission: 'bash',
        command_key: `age-${age}`,
        decision: 'denied' as const,
        count: 1,
        first_seen_at: timestamp,
        last_seen_at: timestamp,
      }))
    );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.cutoffDay).toBe(utcDaysAgo(90));
    expect(body.deletedCount).toBe(2);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_permission_events_count: 2, has_more: false })
    );
    const remaining = await db.select().from(organization_permission_events_daily);
    expect(remaining.map(row => row.command_key).sort()).toEqual(['age-89', 'age-90']);
  });

  it('stops at the per-run batch cap and reports hasMore', async () => {
    await createRows(BATCH_SIZE * MAX_BATCHES_PER_RUN + 1, utcDaysAgo(100));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(BATCH_SIZE * MAX_BATCHES_PER_RUN);
    expect(body.batchesRun).toBe(MAX_BATCHES_PER_RUN);
    expect(body.hasMore).toBe(true);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ has_more: true, batches_run: MAX_BATCHES_PER_RUN })
    );
    expect(await db.select().from(organization_permission_events_daily)).toHaveLength(1);

    const nextResponse = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const nextBody = await nextResponse.json();

    expect(nextBody.deletedCount).toBe(1);
    expect(nextBody.hasMore).toBe(false);
    expect(await db.select().from(organization_permission_events_daily)).toHaveLength(0);
  });

  it('keeps deleting until every expired row is gone within the cap', async () => {
    await createRows(7_001, utcDaysAgo(100));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(7_001);
    expect(body.batchesRun).toBe(3);
    expect(body.hasMore).toBe(false);
    expect(await db.select().from(organization_permission_events_daily)).toHaveLength(0);
  });
});
