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

import { admin_action_audit_logs } from '@kilocode/db/schema';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET, maxDuration } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const BATCH_SIZE = 2_500;
const TIME_BUDGET_MS = 120_000;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

function auditRow(message: string, createdAt: string) {
  return {
    action: 'user.api_key.reset' as const,
    actor_id: 'admin-user',
    target_type: 'user' as const,
    target_id: 'target-user',
    message,
    created_at: createdAt,
  };
}

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-admin-action-audit-logs', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cleanup-admin-action-audit-logs', () => {
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

  it('reports zero deletions when no rows have expired', async () => {
    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(0);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_admin_action_audit_logs_count: 0, has_more: false })
    );
  });

  it('deletes rows older than six months and preserves recent rows', async () => {
    await db
      .insert(admin_action_audit_logs)
      .values([184, 182].map((age, index) => auditRow(`cleanup-event-${index}`, daysAgo(age))));

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.deletedCount).toBe(1);
    expect(body.batchSize).toBe(BATCH_SIZE);
    expect(body.hasMore).toBe(false);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_admin_action_audit_logs_count: 1, has_more: false })
    );
    const remaining = await db.select().from(admin_action_audit_logs);
    expect(remaining.map(row => row.message)).toEqual(['cleanup-event-1']);
  });

  it('drains a second batch when the first reports more expired rows', async () => {
    await db
      .insert(admin_action_audit_logs)
      .values(
        Array.from({ length: BATCH_SIZE + 1 }, (_, index) =>
          auditRow(`cleanup-batch-${index}`, daysAgo(184))
        )
      );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(BATCH_SIZE + 1);
    expect(body.batchesRun).toBe(2);
    expect(body.hasMore).toBe(false);
    const remaining = await db
      .select({ id: admin_action_audit_logs.id })
      .from(admin_action_audit_logs);
    expect(remaining).toHaveLength(0);
  });

  it('keeps deleting batches until no expired rows are left', async () => {
    await db
      .insert(admin_action_audit_logs)
      .values(
        Array.from({ length: BATCH_SIZE * 2 + 1 }, (_, index) =>
          auditRow(`cleanup-drain-${index}`, daysAgo(184))
        )
      );

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
    const body = await response.json();

    expect(body.deletedCount).toBe(BATCH_SIZE * 2 + 1);
    expect(body.batchesRun).toBe(3);
    expect(body.hasMore).toBe(false);
    const remaining = await db
      .select({ id: admin_action_audit_logs.id })
      .from(admin_action_audit_logs);
    expect(remaining).toHaveLength(0);
  });

  it('stops once the time budget is used and reports the expired rows left', async () => {
    await db
      .insert(admin_action_audit_logs)
      .values(
        Array.from({ length: BATCH_SIZE + 1 }, (_, index) =>
          auditRow(`cleanup-budget-${index}`, daysAgo(184))
        )
      );
    const startedAt = Date.now();
    // The run reads the clock once to start, then after each batch.
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(startedAt)
      .mockReturnValue(startedAt + TIME_BUDGET_MS);

    try {
      const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));
      const body = await response.json();

      expect(body.deletedCount).toBe(BATCH_SIZE);
      expect(body.batchesRun).toBe(1);
      expect(body.hasMore).toBe(true);
      expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          deleted_admin_action_audit_logs_count: BATCH_SIZE,
          has_more: true,
        })
      );
    } finally {
      now.mockRestore();
    }
    const remaining = await db
      .select({ id: admin_action_audit_logs.id })
      .from(admin_action_audit_logs);
    expect(remaining).toHaveLength(1);
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
