jest.mock('@/lib/config.server', () => ({
  get CRON_SECRET() {
    return mockCronSecret;
  },
}));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(options => ({
    runId: 'run-id',
    startedAt: 0,
    ...options,
  })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => ({ outcome: 'succeeded', ...fields })),
  buildScheduledJobFailureEvent: jest.fn(({ metadata }) => ({
    outcome: 'failed',
    exception_name: 'Error',
    ...metadata,
  })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/model-stats/sync-enkrypt', () => ({ syncEnkryptBenchmarks: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { syncEnkryptBenchmarks } from '@/lib/model-stats/sync-enkrypt';
import { GET, maxDuration } from './route';

let mockCronSecret: string | undefined = 'cron-secret';
const mockSyncEnkryptBenchmarks = jest.mocked(syncEnkryptBenchmarks);

function request(authorization?: string) {
  return new NextRequest('http://localhost/api/cron/sync-enkrypt', {
    headers: authorization === undefined ? undefined : { authorization },
  });
}

describe('GET /api/cron/sync-enkrypt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncEnkryptBenchmarks.mockReset();
    mockCronSecret = 'cron-secret';
  });

  it.each([
    undefined,
    '',
    'Bearer wrong-secret',
    'bearer cron-secret',
    'cron-secret',
    'Bearer cron-secret-extra',
    'Bearer  cron-secret',
  ])('rejects authorization %p before starting any work', async authorization => {
    const response = await GET(request(authorization));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockSyncEnkryptBenchmarks).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('rejects an unconfigured secret %p', async secret => {
    mockCronSecret = secret;

    const response = await GET(request(`Bearer ${secret}`));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockSyncEnkryptBenchmarks).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('returns only summary counters and emits one success event', async () => {
    const counters = {
      fetchedCount: 5,
      matchedCount: 2,
      unmatchedCount: 2,
      ambiguousCount: 1,
      updatedCount: 2,
    };
    const result = {
      ...counters,
      unmatchedModelNames: ['unmatched-model-a', 'unmatched-model-b'],
      upstreamMetadata: 'not-for-output',
    };
    mockSyncEnkryptBenchmarks.mockResolvedValue(result);

    const response = await GET(request('Bearer cron-secret'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, ...counters });
    expect(maxDuration).toBe(120);
    expect(mockSyncEnkryptBenchmarks).toHaveBeenCalledTimes(1);
    expect(mockSyncEnkryptBenchmarks).toHaveBeenCalledWith();
    expect(createScheduledJobRun).toHaveBeenCalledTimes(1);
    expect(createScheduledJobRun).toHaveBeenCalledWith({
      jobName: 'web.sync_enkrypt',
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    });
    expect(buildScheduledJobSuccessEvent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-id', jobName: 'web.sync_enkrypt' }),
      {
        fetched_count: 5,
        matched_count: 2,
        unmatched_count: 2,
        ambiguous_count: 1,
        updated_count: 2,
      }
    );
    expect(emitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(emitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'succeeded',
      fetched_count: 5,
      matched_count: 2,
      unmatched_count: 2,
      ambiguous_count: 1,
      updated_count: 2,
    });
    expect(buildScheduledJobFailureEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([
    new Error('sensitive upstream response'),
    { body: 'sensitive upstream response', headers: { authorization: 'sensitive header' } },
    new Error('ENKRYPT_API_KEY is not configured'),
  ])('returns a generic failure and emits safe observability for %p', async failure => {
    mockSyncEnkryptBenchmarks.mockRejectedValue(failure);

    const response = await GET(request('Bearer cron-secret'));
    const safeError = new Error('Failed to sync Enkrypt benchmarks');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Failed to sync Enkrypt benchmarks',
    });
    expect(mockSyncEnkryptBenchmarks).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(safeError, {
      tags: { endpoint: 'cron/sync-enkrypt' },
    });
    expect(jest.mocked(captureException).mock.calls[0]?.[0]).not.toBe(failure);
    expect(buildScheduledJobFailureEvent).toHaveBeenCalledWith({
      context: expect.objectContaining({ runId: 'run-id', jobName: 'web.sync_enkrypt' }),
      jobName: 'web.sync_enkrypt',
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      error: safeError,
      metadata: { sync_failure_count: 1 },
    });
    expect(emitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(emitScheduledJobEvent).toHaveBeenCalledWith({
      outcome: 'failed',
      exception_name: 'Error',
      sync_failure_count: 1,
    });
    expect(buildScheduledJobSuccessEvent).not.toHaveBeenCalled();
  });
});
