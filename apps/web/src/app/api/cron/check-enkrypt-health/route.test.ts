jest.mock('@/lib/config.server', () => ({
  get CRON_SECRET() {
    return mockCronSecret;
  },
  get ENKRYPT_SYNC_ENABLED() {
    return mockEnabled;
  },
  ENKRYPT_API_KEY: 'test-key',
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: mockRead })) })),
    insert: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    transaction: jest.fn(),
  },
}));
jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  ...jest.requireActual('@kilocode/worker-utils/scheduled-job-observability'),
  createScheduledJobRun: jest.fn(options => ({ runId: 'run-id', startedAt: 0, ...options })),
  emitScheduledJobEvent: jest.fn(),
}));
jest.mock('@/lib/model-stats/enkrypt-status', () => {
  const actual = jest.requireActual<typeof EnkryptStatus>('@/lib/model-stats/enkrypt-status');
  return { ...actual, getEnkryptSyncHealth: jest.fn(actual.getEnkryptSyncHealth) };
});
jest.mock('@/lib/slack/admin-notifications', () => ({ sendAdminSlackNotification: jest.fn() }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { EnkryptFailureCategorySchema } from '@kilocode/db/schema-types';
import { db } from '@/lib/drizzle';
import { getEnkryptSyncHealth } from '@/lib/model-stats/enkrypt-status';
import type * as EnkryptStatus from '@/lib/model-stats/enkrypt-status';
import { sendAdminSlackNotification } from '@/lib/slack/admin-notifications';
import vercelConfig from '../../../../../vercel.json';
import { GET, maxDuration } from './route';

let mockCronSecret: string | undefined = 'cron-secret';
let mockEnabled = true;
const mockRead = jest.fn<Promise<unknown[]>, []>();
const mockHealth = jest.mocked(getEnkryptSyncHealth);
const sensitive = 'sensitive-header-body-SQL-parameters';
const now = '2026-08-27T12:00:00.000Z';
const checkedAt = '2026-08-27T11:00:00.000Z';
const counts = {
  fetchedCount: 6,
  rejectedCount: 1,
  matchedCount: 2,
  unmatchedCount: 2,
  ambiguousCount: 1,
  updatedCount: 0,
};
const state = {
  last_attempt_at: checkedAt,
  last_completed_at: checkedAt,
  last_success_at: checkedAt,
  last_outcome: 'succeeded',
  last_failure_category: null,
  last_counts: counts,
  last_success_counts: counts,
  baseline_matched_count: 2,
};
const healthy = {
  status: 'healthy',
  reason: null,
  lastAttemptAt: checkedAt,
  lastSuccessAt: checkedAt,
  counts,
  lastSuccessCounts: counts,
  baselineMatchedCount: 2,
};
const unavailable = {
  status: 'unavailable',
  reason: 'monitor_error',
  lastAttemptAt: null,
  lastSuccessAt: null,
  counts: null,
  lastSuccessCounts: null,
  baselineMatchedCount: null,
};

function request(authorization = 'Bearer cron-secret') {
  return new NextRequest('http://localhost/api/cron/check-enkrypt-health', {
    headers: { authorization },
  });
}

function expectReadOnly() {
  for (const method of ['insert', 'update', 'delete', 'transaction'] as const) {
    expect(jest.spyOn(db, method)).not.toHaveBeenCalled();
  }
  expect(sendAdminSlackNotification).not.toHaveBeenCalled();
}

function expectSafeObservability() {
  expect(JSON.stringify(jest.mocked(captureException).mock.calls)).not.toContain(sensitive);
  expect(JSON.stringify(jest.mocked(emitScheduledJobEvent).mock.calls)).not.toContain(sensitive);
}

describe('GET /api/cron/check-enkrypt-health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRead.mockReset().mockResolvedValue([state]);
    mockHealth
      .mockReset()
      .mockImplementation(
        jest.requireActual<typeof EnkryptStatus>('@/lib/model-stats/enkrypt-status')
          .getEnkryptSyncHealth
      );
    mockCronSecret = 'cron-secret';
    mockEnabled = true;
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', VERCEL_ENV: 'production' });
    jest.useFakeTimers().setSystemTime(new Date(now));
  });

  afterEach(() => {
    expectReadOnly();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    '',
    'Bearer wrong-secret',
    'bearer cron-secret',
    'cron-secret',
    'Bearer cron-secret-extra',
    'Bearer  cron-secret',
  ])('rejects authorization %p before starting work', async authorization => {
    const response = await GET(request(authorization));
    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(mockHealth).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('rejects a missing authorization header', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/check-enkrypt-health'));
    expect(response.status).toBe(401);
    expect(mockHealth).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('rejects an unconfigured secret %p', async secret => {
    mockCronSecret = secret;
    expect((await GET(request(`Bearer ${secret}`))).status).toBe(401);
    expect(mockHealth).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
  });

  it('returns disabled without reading state', async () => {
    mockEnabled = false;
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ ...unavailable, status: 'disabled', reason: null });
    expect(db.select).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded', status: 'disabled', skipped: true })
    );
  });

  it('reports a zero-change successful check as healthy using only explicit primary fields', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(healthy);
    const fields = jest.mocked(db.select).mock.calls[0]?.[0];
    expect(Object.keys(fields ?? {}).sort()).toEqual(Object.keys(state).sort());
    expect(fields).not.toHaveProperty('verified_models');
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded', matched_count: 2, updated_count: 0 })
    );
    expect(maxDuration).toBe(60);
  });

  it.each(EnkryptFailureCategorySchema.options)(
    'reports failed %s attempts as unhealthy',
    async reason => {
      mockRead.mockResolvedValue([
        { ...state, last_outcome: 'failed', last_failure_category: reason },
      ]);
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ ...healthy, status: 'degraded', reason });
      expect(emitScheduledJobEvent).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', status: 'degraded', reason, updated_count: 0 })
      );
    }
  );

  it('reports a missed run at 26 hours even if a new attempt is running', async () => {
    mockRead.mockResolvedValue([
      {
        ...state,
        last_attempt_at: now,
        last_completed_at: null,
        last_outcome: 'running',
        last_counts: null,
        last_success_at: '2026-08-26T10:00:00.000Z',
      },
    ]);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ...healthy,
      status: 'stale',
      reason: 'stale',
      lastAttemptAt: now,
      lastSuccessAt: '2026-08-26T10:00:00.000Z',
      counts: null,
    });
  });

  it('reports a never-run job without creating state', async () => {
    mockRead.mockResolvedValue([]);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ...unavailable,
      status: 'never_succeeded',
      reason: 'never_succeeded',
    });
  });

  it.each(['sequential', 'concurrent'] as const)(
    'keeps repeated %s polls identical and read-only',
    async mode => {
      const stale = { ...state, last_success_at: '2026-08-26T04:00:00.000Z' };
      const before = structuredClone(stale);
      mockRead.mockResolvedValue([stale]);
      const responses =
        mode === 'concurrent'
          ? await Promise.all([GET(request()), GET(request())])
          : [await GET(request()), await GET(request())];
      const bodies = await Promise.all(responses.map(response => response.json()));
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[0]).toEqual({
        ...healthy,
        status: 'stale',
        reason: 'stale',
        lastSuccessAt: stale.last_success_at,
      });
      expect(responses.map(response => response.status)).toEqual([503, 503]);
      expect(mockRead).toHaveBeenCalledTimes(2);
      expect(stale).toEqual(before);
    }
  );

  it.each([
    { last_failure_category: sensitive },
    { last_outcome: sensitive },
    { last_success_at: sensitive },
    { last_completed_at: 'infinity' },
    { last_attempt_at: '2026-08-28T00:00:00.000Z' },
    { last_counts: { ...counts, rejectedCount: sensitive } },
    { last_success_counts: { ...counts, matchedCount: -1 } },
    { last_success_counts: { ...counts, fetchedCount: 7 } },
    { baseline_matched_count: Infinity },
  ])('fails closed on malformed persisted data: %p', async invalid => {
    mockRead.mockResolvedValue([{ ...state, ...invalid }]);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(unavailable);
    expectSafeObservability();
  });

  it('strips unowned persisted fields before HTTP and observability', async () => {
    mockRead.mockResolvedValue([
      {
        ...state,
        last_attempt_at: '2026-08-27 11:00:00.000+00',
        last_success_at: '2026-08-27 11:00:00.000+00',
        last_counts: { ...counts, rawBody: sensitive },
        last_success_counts: { ...counts, sqlParameters: sensitive },
        verified_models: { raw: sensitive },
        headers: sensitive,
      },
    ]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(healthy);
    expectSafeObservability();
  });

  it('sanitizes database read failures', async () => {
    mockRead.mockRejectedValue(new Error(sensitive));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(unavailable);
    expectSafeObservability();
  });

  it('sanitizes unexpected helper exceptions without retaining the original', async () => {
    const failure = Object.assign(new Error(sensitive), {
      stack: sensitive,
      cause: new Error(sensitive),
    });
    mockHealth.mockRejectedValue(failure);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(unavailable);
    const captured = jest.mocked(captureException).mock.calls[0]?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured).not.toBe(failure);
    expect(captured).toHaveProperty('message', 'Enkrypt health check operation failed');
    expect(captured).not.toHaveProperty('cause');
    if (captured instanceof Error) expect(captured.stack).not.toContain(sensitive);
    expectSafeObservability();
  });

  it('leaves monitoring external while preserving daily 04:00 UTC ingestion and six-hour catalog sync', () => {
    expect(vercelConfig.crons.filter(cron => cron.path.includes('enkrypt'))).toEqual([
      { path: '/api/cron/sync-enkrypt', schedule: '0 4 * * *' },
    ]);
    expect(vercelConfig.crons.filter(cron => cron.path === '/api/cron/sync-model-stats')).toEqual([
      { path: '/api/cron/sync-model-stats', schedule: '0 */6 * * *' },
    ]);
  });
});
