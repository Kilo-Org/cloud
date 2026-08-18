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

jest.mock('@/lib/ai-gateway/providers/openrouter/sync-providers-stale-alert', () => ({
  alertIfSyncProvidersStale: jest.fn(),
}));

import { alertIfSyncProvidersStale } from '@/lib/ai-gateway/providers/openrouter/sync-providers-stale-alert';
import { syncAndStoreProviders } from '@/lib/ai-gateway/providers/openrouter/sync-providers';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET, maxDuration } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const mockAlertIfSyncProvidersStale = jest.mocked(alertIfSyncProvidersStale);

describe('GET /api/cron/sync-providers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('exports maxDuration of 4 minutes (240 seconds)', () => {
    expect(maxDuration).toBe(240);
  });

  it('emits one event at the cron boundary with aggregate provider counts', async () => {
    jest.mocked(syncAndStoreProviders).mockResolvedValue({
      id: 1,
      generated_at: '2026-07-20T00:00:00.000Z',
      completed_at: '2026-07-20T00:05:00.000Z',
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
    expect(mockAlertIfSyncProvidersStale).toHaveBeenCalledTimes(1);
    expect(mockAlertIfSyncProvidersStale.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(syncAndStoreProviders).mock.invocationCallOrder[0]
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      total_provider_count: 12,
      total_model_count: 42,
    });
  });

  it('still runs the full sync when the stale-alert check rejects', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockAlertIfSyncProvidersStale.mockRejectedValue(new Error('alert failed'));
    jest.mocked(syncAndStoreProviders).mockResolvedValue({
      id: 1,
      generated_at: '2026-07-20T00:00:00.000Z',
      completed_at: '2026-07-20T00:05:00.000Z',
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
    expect(syncAndStoreProviders).toHaveBeenCalledTimes(1);
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
