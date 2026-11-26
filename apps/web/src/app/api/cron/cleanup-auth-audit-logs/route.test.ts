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

import { admin_action_audit_logs, auth_audit_logs } from '@kilocode/db/schema';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET, maxDuration } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-auth-audit-logs', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cleanup-auth-audit-logs', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(cleanupDbForTest);

  it('exports maxDuration of 300 seconds', () => {
    expect(maxDuration).toBe(300);
  });

  it('rejects requests without the cron secret and deletes nothing', async () => {
    await db.insert(auth_audit_logs).values({
      action: 'auth.sign_in',
      outcome: 'success',
      created_at: daysAgo(400),
    });

    const response = await GET(makeRequest({ authorization: 'Bearer not-the-secret' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
    expect(await db.select().from(auth_audit_logs)).toHaveLength(1);
  });

  it('prunes only auth audit rows older than 183 days', async () => {
    await db.insert(auth_audit_logs).values(
      [184, 182].map((age, index) => ({
        action: 'auth.sign_in' as const,
        outcome: 'success' as const,
        metadata: { marker: `auth-${index}` },
        created_at: daysAgo(age),
      }))
    );
    await db.insert(admin_action_audit_logs).values({
      action: 'user.api_key.reset',
      actor_id: 'admin-user',
      message: 'old admin row',
      created_at: daysAgo(184),
    });

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_auth_audit_logs_count: 1, has_more: false })
    );
    const remaining = await db.select().from(auth_audit_logs);
    expect(remaining.map(row => row.metadata?.marker)).toEqual(['auth-1']);
    // The admin table has its own cron.
    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(1);
  });
});
