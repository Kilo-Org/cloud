import { NextRequest } from 'next/server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn(() => ({ outcome: 'failed', exception_name: 'Error' })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/providers/metadata-cache/refresh-metadata-cache', () => ({
  refreshMetadataCache: jest.fn(),
}));

import { refreshMetadataCache } from '@/lib/providers/metadata-cache/refresh-metadata-cache';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);
const mockRefreshMetadataCache = jest.mocked(refreshMetadataCache);

function cronRequest(headers?: HeadersInit) {
  return new NextRequest('http://localhost/api/cron/refresh-ai-gateway-metadata-cache', {
    headers,
  });
}

describe('GET /api/cron/refresh-ai-gateway-metadata-cache', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects requests without the cron secret', async () => {
    const response = await GET(cronRequest());

    expect(response.status).toBe(401);
    expect(mockRefreshMetadataCache).not.toHaveBeenCalled();
    expect(mockEmitScheduledJobEvent).not.toHaveBeenCalled();
  });

  it('returns the refresh summary and emits it in the success event', async () => {
    const summary = { source_count: 20, failed_count: 2, stale_count: 1 };
    mockRefreshMetadataCache.mockResolvedValue(summary);

    const response = await GET(cronRequest({ authorization: 'Bearer cron-secret' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(summary);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({ outcome: 'succeeded', ...summary });
  });

  it('emits one failure event then rethrows', async () => {
    mockRefreshMetadataCache.mockRejectedValue(new Error('refresh failed'));

    await expect(GET(cronRequest({ authorization: 'Bearer cron-secret' }))).rejects.toThrow(
      'refresh failed'
    );
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });
});
