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

import { syncAndStoreDirectByokProviders } from '@/lib/providers/direct-byok/sync-direct-byok';
import {
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
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
  });

  it('syncs and emits aggregate counts', async () => {
    mockSync.mockResolvedValue(summary);

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(summary);
    expect(createScheduledJobRun).toHaveBeenCalledWith(
      expect.objectContaining({ jobName: 'web.sync_direct_byok_providers' })
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      total_provider_count: 2,
      total_model_count: 7,
    });
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
