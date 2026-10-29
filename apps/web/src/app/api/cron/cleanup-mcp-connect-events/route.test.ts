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

import { organization_mcp_connect_events } from '@kilocode/db/schema';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET, maxDuration } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const BATCH_SIZE = 2_500;
const MAX_BATCHES_PER_RUN = 10;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-mcp-connect-events', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cleanup-mcp-connect-events', () => {
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

  it('deletes events older than 90 days and keeps recent ones', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('MCP cleanup org', user.id, 0);
    await db.insert(organization_mcp_connect_events).values(
      [91, 89].map(age => ({
        organization_id: organization.id,
        kilo_user_id: user.id,
        client: 'cli',
        decision: 'denied' as const,
        identity_key: `npm:server-${age}`,
        target: {
          kind: 'package' as const,
          ecosystem: 'npm' as const,
          identifier: `server-${age}`,
        },
        created_at: daysAgo(age),
      }))
    );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_mcp_connect_events_count: 1, has_more: false })
    );
    const remaining = await db.select().from(organization_mcp_connect_events);
    expect(remaining.map(row => row.identity_key)).toEqual(['npm:server-89']);
  });

  it('stops at the per-run batch cap and reports hasMore', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('MCP cleanup capped org', user.id, 0);
    const expiredCount = BATCH_SIZE * MAX_BATCHES_PER_RUN + 1;
    const rows = Array.from({ length: expiredCount }, () => ({
      organization_id: organization.id,
      kilo_user_id: user.id,
      client: 'cli',
      decision: 'denied' as const,
      identity_key: 'npm:backlog',
      target: { kind: 'package' as const, ecosystem: 'npm' as const, identifier: 'backlog' },
      created_at: daysAgo(100),
    }));
    for (let i = 0; i < rows.length; i += 5_000) {
      await db.insert(organization_mcp_connect_events).values(rows.slice(i, i + 5_000));
    }

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(BATCH_SIZE * MAX_BATCHES_PER_RUN);
    expect(body.batchesRun).toBe(MAX_BATCHES_PER_RUN);
    expect(body.hasMore).toBe(true);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ has_more: true, batches_run: MAX_BATCHES_PER_RUN })
    );
    expect(await db.select().from(organization_mcp_connect_events)).toHaveLength(1);

    const nextResponse = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const nextBody = await nextResponse.json();

    expect(nextBody.deletedCount).toBe(1);
    expect(nextBody.hasMore).toBe(false);
    expect(await db.select().from(organization_mcp_connect_events)).toHaveLength(0);
  });

  it('keeps deleting until every expired event is gone within the cap', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('MCP cleanup backlog org', user.id, 0);
    const expiredCount = 7_001;
    await db.insert(organization_mcp_connect_events).values(
      Array.from({ length: expiredCount }, () => ({
        organization_id: organization.id,
        kilo_user_id: user.id,
        client: 'cli',
        decision: 'denied' as const,
        identity_key: 'npm:backlog',
        target: { kind: 'package' as const, ecosystem: 'npm' as const, identifier: 'backlog' },
        created_at: daysAgo(100),
      }))
    );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(expiredCount);
    expect(body.batchesRun).toBe(3);
    expect(body.hasMore).toBe(false);
    expect(await db.select().from(organization_mcp_connect_events)).toHaveLength(0);
  });
});
