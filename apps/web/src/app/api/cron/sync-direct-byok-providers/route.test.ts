import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn(() => ({ outcome: 'failed', exception_name: 'Error' })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/providers/direct-byok/sync-direct-byok', () => ({
  syncAndStoreDirectByokProviders: jest.fn(),
}));

jest.mock('@/lib/providers/openrouter/sync-providers-stale-alert', () => ({
  alertIfSyncStale: jest.fn(),
}));

import { alertIfSyncStale } from '@/lib/providers/openrouter/sync-providers-stale-alert';
import { syncAndStoreDirectByokProviders } from '@/lib/providers/direct-byok/sync-direct-byok';
import {
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const mockAlertIfSyncStale = jest.mocked(alertIfSyncStale);
const mockSync = jest.mocked(syncAndStoreDirectByokProviders);

const summary = {
  completed_at: '2026-07-20T00:05:00.000Z',
  total_providers: 2,
  total_models: 7,
  direct_byok_model_counts: { neuralwatt: 3, 'chutes-byok': 4 },
  time: 5,
};

function cronRequest(authorization = 'Bearer cron-secret') {
  return new NextRequest('http://localhost/api/cron/sync-direct-byok-providers', {
    headers: { authorization },
  });
}

describe('GET /api/cron/sync-direct-byok-providers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects requests without the cron secret', async () => {
    const response = await GET(cronRequest('Bearer wrong'));

    expect(response.status).toBe(401);
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockAlertIfSyncStale).not.toHaveBeenCalled();
  });

  it('checks the direct BYOK stale alert before syncing and emits aggregate counts', async () => {
    mockSync.mockResolvedValue(summary);

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(summary);
    expect(createScheduledJobRun).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'web.sync_direct_byok_providers' })
    );
    expect(mockAlertIfSyncStale).toHaveBeenCalledWith('direct_byok');
    expect(mockAlertIfSyncStale.mock.invocationCallOrder[0]).toBeLessThan(
      mockSync.mock.invocationCallOrder[0]
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      total_provider_count: 2,
      total_model_count: 7,
    });
  });

  it('still runs the sync when the stale-alert check rejects', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAlertIfSyncStale.mockRejectedValue(new Error('alert failed'));
    mockSync.mockResolvedValue(summary);

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    expect(mockSync).toHaveBeenCalledTimes(1);
  });

  it('emits one failure event then rethrows', async () => {
    mockSync.mockRejectedValue(new Error('sync failed'));

    await expect(GET(cronRequest())).rejects.toThrow('sync failed');
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });
});
