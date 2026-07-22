import { NextRequest } from 'next/server';

jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn(() => ({ outcome: 'failed', exception_name: 'Error' })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/providers/openrouter/sync-providers', () => ({
  syncAndStoreProviders: jest.fn(),
}));

import { syncAndStoreProviders } from '@/lib/ai-gateway/providers/openrouter/sync-providers';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

describe('GET /api/cron/sync-providers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits one event at the cron boundary with aggregate provider counts', async () => {
    jest.mocked(syncAndStoreProviders).mockResolvedValue({
      id: 1,
      generated_at: '2026-07-20T00:00:00.000Z',
      total_models: 42,
      total_providers: 12,
      direct_byok_model_counts: {},
      time: 5,
    });

    const response = await GET(
      new NextRequest('http://localhost/api/cron/sync-providers', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      total_provider_count: 12,
      total_model_count: 42,
    });
  });

  it('emits one failure event then preserves rejected helper failure semantics', async () => {
    jest.mocked(syncAndStoreProviders).mockRejectedValue(new Error('sync failed'));

    await expect(
      GET(
        new NextRequest('http://localhost/api/cron/sync-providers', {
          headers: { authorization: 'Bearer cron-secret' },
        })
      )
    ).rejects.toThrow('sync failed');
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });
});
