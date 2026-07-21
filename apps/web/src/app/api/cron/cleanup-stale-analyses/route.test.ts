jest.mock('@/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn(() => ({ outcome: 'failed', exception_name: 'Error' })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/security-agent/db/security-analysis', () => ({ cleanupStaleAnalyses: jest.fn() }));
jest.mock('@/lib/utils.server', () => ({ sentryLogger: jest.fn(() => jest.fn()) }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { cleanupStaleAnalyses } from '@/lib/security-agent/db/security-analysis';
import { emitScheduledJobEvent } from '@kilocode/worker-utils/scheduled-job-observability';
import { GET } from './route';

const mockEmitScheduledJobEvent = jest.mocked(emitScheduledJobEvent);

describe('GET /api/cron/cleanup-stale-analyses', () => {
  beforeEach(() => jest.clearAllMocks());

  it('emits a success event for a no-work cleanup', async () => {
    jest.mocked(cleanupStaleAnalyses).mockResolvedValue(0);

    const response = await GET(
      new Request('http://localhost/api/cron/cleanup-stale-analyses', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      cleaned_count: 0,
      anomaly_threshold: 10,
      anomaly_detected: false,
    });
  });

  it('emits a failure event before returning its existing error response', async () => {
    jest.mocked(cleanupStaleAnalyses).mockRejectedValue(new Error('cleanup failed'));

    const response = await GET(
      new Request('http://localhost/api/cron/cleanup-stale-analyses', {
        headers: { authorization: 'Bearer cron-secret' },
      })
    );

    expect(response.status).toBe(500);
    expect(mockEmitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
    });
  });
});
