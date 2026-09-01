jest.mock('@/lib/config.server', () => ({
  get CRON_SECRET() {
    return mockCronSecret;
  },
}));

jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  ...jest.requireActual('@kilocode/worker-utils/scheduled-job-observability'),
  createScheduledJobRun: jest.fn(options => ({
    runId: 'run-id',
    startedAt: 0,
    ...options,
  })),
  emitScheduledJobEvent: jest.fn(),
}));

jest.mock('@/lib/model-stats/sync-enkrypt', () => ({ syncEnkryptBenchmarks: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { EnkryptFailureCategorySchema } from '@kilocode/db/schema-types';
import { EnkryptSyncError } from '@/lib/model-stats/enkrypt-errors';
import { syncEnkryptBenchmarks } from '@/lib/model-stats/sync-enkrypt';
import { GET, maxDuration } from './route';

let mockCronSecret: string | undefined = 'cron-secret';
const mockSync = jest.mocked(syncEnkryptBenchmarks);
const counts = {
  fetchedCount: 6,
  rejectedCount: 1,
  matchedCount: 2,
  unmatchedCount: 2,
  ambiguousCount: 1,
  updatedCount: 2,
};
const countMetadata = {
  fetched_count: 6,
  rejected_count: 1,
  matched_count: 2,
  unmatched_count: 2,
  ambiguous_count: 1,
  updated_count: 2,
};
const ingestedAt = '2026-08-27T04:00:00.000Z';
const sensitive = 'sensitive-header-body-SQL-parameters';

function request(authorization: string | undefined = 'Bearer cron-secret') {
  return new NextRequest('http://localhost/api/cron/sync-enkrypt', {
    headers: authorization === undefined ? undefined : { authorization },
  });
}

function expectSanitized(failure: unknown) {
  const captured = jest.mocked(captureException).mock.calls[0]?.[0];
  expect(captured).toBeInstanceOf(EnkryptSyncError);
  expect(captured).not.toBe(failure);
  expect(captured).toHaveProperty('message', 'Enkrypt synchronization failed');
  expect(captured).not.toHaveProperty('cause');
  expect(JSON.stringify(captured)).not.toContain(sensitive);
  if (captured instanceof Error) expect(captured.stack).not.toContain(sensitive);
  expect(JSON.stringify(jest.mocked(captureException).mock.calls)).not.toContain(sensitive);
  expect(JSON.stringify(jest.mocked(emitScheduledJobEvent).mock.calls)).not.toContain(sensitive);
}

describe('GET /api/cron/sync-enkrypt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSync.mockReset();
    mockCronSecret = 'cron-secret';
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', VERCEL_ENV: 'preview' });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
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
    expect(mockSync).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('rejects a missing authorization header', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/sync-enkrypt'));
    expect(response.status).toBe(401);
    expect(mockSync).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('rejects an unconfigured secret %p', async secret => {
    mockCronSecret = secret;
    const response = await GET(request(`Bearer ${secret}`));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockSync).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports disabled as skipped without an ingestion or last-success timestamp', async () => {
    mockSync.mockResolvedValue({ status: 'disabled' });
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'disabled' });
    expect(emitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        job_name: 'web.sync_enkrypt',
        outcome: 'succeeded',
        status: 'disabled',
        skipped: true,
      })
    );
    const event = jest.mocked(emitScheduledJobEvent).mock.calls[0]?.[0];
    expect(event).not.toHaveProperty('ingested_at');
    expect(event).not.toHaveProperty('last_success_at');
    expect(event).not.toHaveProperty('updated_count');
    expect(captureException).not.toHaveBeenCalled();
  });

  it('returns only the succeeded contract and emits all six counters', async () => {
    const result = {
      status: 'succeeded' as const,
      ...counts,
      ingestedAt,
      unmatchedModelNames: [sensitive],
      upstreamMetadata: sensitive,
    };
    mockSync.mockResolvedValue(result);
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'succeeded', ...counts, ingestedAt });
    expect(maxDuration).toBe(120);
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith();
    expect(createScheduledJobRun).toHaveBeenCalledWith({
      jobName: 'web.sync_enkrypt',
      environment: 'preview',
    });
    expect(emitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'succeeded',
        status: 'succeeded',
        ingested_at: ingestedAt,
        ...countMetadata,
      })
    );
    expect(JSON.stringify(jest.mocked(emitScheduledJobEvent).mock.calls)).not.toContain(sensitive);
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each(EnkryptFailureCategorySchema.options)(
    'reports the allowlisted %s category with sanitized counters and HTTP status',
    async category => {
      const failure = Object.assign(
        new EnkryptSyncError(category, {
          counts: { ...counts, rawBody: sensitive } as typeof counts,
          httpStatus: 429,
        }),
        { message: sensitive, name: sensitive, stack: sensitive, cause: new Error(sensitive) }
      );
      mockSync.mockRejectedValue(failure);
      const response = await GET(request());

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        status: 'failed',
        error: 'Failed to sync Enkrypt benchmarks',
        category,
        counts,
        httpStatus: 429,
      });
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException).toHaveBeenCalledWith(expect.any(EnkryptSyncError), {
        tags: { endpoint: 'cron/sync-enkrypt', category, http_status: 429, ...countMetadata },
      });
      expect(emitScheduledJobEvent).toHaveBeenCalledTimes(1);
      expect(emitScheduledJobEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          job_name: 'web.sync_enkrypt',
          outcome: 'failed',
          status: 'failed',
          exception_name: 'EnkryptSyncError',
          sync_failure_count: 1,
          category,
          http_status: 429,
          ...countMetadata,
        })
      );
      expectSanitized(failure);
    }
  );

  it.each([
    new Error(sensitive),
    { category: 'authentication', counts, httpStatus: 403, headers: sensitive, body: sensitive },
    sensitive,
    null,
  ])('maps unknown failures to unexpected without retaining raw data: %p', async failure => {
    mockSync.mockRejectedValue(failure);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      status: 'failed',
      error: 'Failed to sync Enkrypt benchmarks',
      category: 'unexpected',
    });
    expectSanitized(failure);
  });

  it('rejects an invalid category even on an owned error', async () => {
    const failure = Object.assign(new EnkryptSyncError('upstream'), { category: sensitive });
    mockSync.mockRejectedValue(failure);
    const response = await GET(request());
    expect(await response.json()).toMatchObject({ category: 'unexpected' });
    expectSanitized(failure);
  });

  it.each([undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, sensitive])(
    'omits invalid counts from all outputs when rejectedCount is %p',
    async rejectedCount => {
      const failure = Object.assign(new EnkryptSyncError('coverage'), {
        counts: { ...counts, rejectedCount },
      });
      mockSync.mockRejectedValue(failure);
      const response = await GET(request());
      expect(await response.json()).toEqual({
        status: 'failed',
        error: 'Failed to sync Enkrypt benchmarks',
        category: 'coverage',
      });
      expect(jest.mocked(emitScheduledJobEvent).mock.calls[0]?.[0]).not.toHaveProperty(
        'fetched_count'
      );
      expect(jest.mocked(captureException).mock.calls[0]?.[0]).toHaveProperty('counts', undefined);
      expectSanitized(failure);
    }
  );

  it.each([99, 600, 429.5, NaN, Infinity, sensitive])(
    'omits invalid HTTP status %p',
    async httpStatus => {
      const failure = Object.assign(new EnkryptSyncError('upstream'), { httpStatus });
      mockSync.mockRejectedValue(failure);
      const response = await GET(request());
      expect(await response.json()).not.toHaveProperty('httpStatus');
      expect(jest.mocked(emitScheduledJobEvent).mock.calls[0]?.[0]).not.toHaveProperty(
        'http_status'
      );
      expect(jest.mocked(captureException).mock.calls[0]?.[1]).not.toHaveProperty(
        'tags.http_status'
      );
      expectSanitized(failure);
    }
  );

  it.each([
    { ...counts, rejectedCount: -1, ingestedAt },
    { ...counts, ingestedAt: sensitive },
  ])('does not publish invalid success data: %p', async result => {
    mockSync.mockResolvedValue({ status: 'succeeded', ...result });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: 'failed', category: 'unexpected' });
    expectSanitized(result);
  });
});
