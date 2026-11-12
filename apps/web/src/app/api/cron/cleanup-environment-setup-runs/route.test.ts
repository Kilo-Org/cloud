import { NextRequest } from 'next/server';

const mockCleanupEnvironmentSetupRuns = jest.fn();

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@/lib/cloud-agent/environment-setup/cleanup', () => ({
  cleanupEnvironmentSetupRuns: () => mockCleanupEnvironmentSetupRuns(),
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
  return new NextRequest('http://localhost:3000/api/cron/cleanup-environment-setup-runs', {
    method: 'GET',
    headers,
  });
}

describe('GET /api/cron/cleanup-environment-setup-runs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exports maxDuration of 300 seconds', () => {
    expect(maxDuration).toBe(300);
  });

  it('rejects requests without authorization', async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(mockCleanupEnvironmentSetupRuns).not.toHaveBeenCalled();
    expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
  });

  it('reports cleanup counts', async () => {
    mockCleanupEnvironmentSetupRuns.mockResolvedValue({
      abandoned: 3,
      draftsDeleted: 2,
      previousConfigurationsCleared: 1,
    });

    const response = await GET(makeRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        abandoned: 3,
        draftsDeleted: 2,
        previousConfigurationsCleared: 1,
      })
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        abandoned_count: 3,
        drafts_deleted_count: 2,
        previous_configurations_cleared_count: 1,
      })
    );
  });

  it('reports cleanup failures without treating them as successful', async () => {
    mockCleanupEnvironmentSetupRuns.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(GET(makeRequest({ authorization: 'Bearer cron-secret' }))).rejects.toThrow(
      'database unavailable'
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });
});
