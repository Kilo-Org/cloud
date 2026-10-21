import { NextRequest } from 'next/server';

const mockCleanupWatchPrData = jest.fn();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@/lib/cloud-agent/watch-pr-cleanup', () => ({
  watchPrRetentionDays: 30,
  cleanupWatchPrData: () => mockCleanupWatchPrData(),
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

import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET, maxDuration } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

function makeRequest(headers?: Record<string, string>) {
  return new NextRequest('http://localhost:3000/api/cron/cleanup-pr-watches', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cleanup-pr-watches', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exports maxDuration of 300 seconds', () => {
    expect(maxDuration).toBe(300);
  });

  it('rejects requests without authorization', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockCleanupWatchPrData).not.toHaveBeenCalled();
    expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
  });

  it('reports deleted watch and activity counts', async () => {
    mockCleanupWatchPrData.mockResolvedValue({
      cutoff: '2026-09-20T00:00:00.000Z',
      deletedActivityCount: 3,
      deletedWatchCount: 2,
    });

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        cutoff: '2026-09-20T00:00:00.000Z',
        deletedActivityCount: 3,
        deletedWatchCount: 2,
        retentionDays: 30,
      })
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        deleted_pr_watch_activity_count: 3,
        deleted_pr_watch_count: 2,
        retention_days: 30,
      })
    );
  });

  it('reports cleanup failures without treating them as successful', async () => {
    mockCleanupWatchPrData.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(GET(makeRequest({ authorization: 'Bearer cron-secret' }))).rejects.toThrow(
      'database unavailable'
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });
});
