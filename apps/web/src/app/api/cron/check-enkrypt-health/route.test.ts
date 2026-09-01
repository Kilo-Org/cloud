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

jest.mock('@/lib/model-stats/enkrypt-status', () => ({
  getEnkryptSyncHealth: jest.fn(),
  recordEnkryptSyncAlert: jest.fn(),
}));
jest.mock('@/lib/slack/admin-notifications', () => ({
  ...jest.requireActual('@/lib/slack/admin-notifications'),
  sendAdminSlackNotification: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { EnkryptFailureCategorySchema } from '@kilocode/db/schema-types';
import { EnkryptSyncError } from '@/lib/model-stats/enkrypt-errors';
import { getEnkryptSyncHealth, recordEnkryptSyncAlert } from '@/lib/model-stats/enkrypt-status';
import type { EnkryptSyncHealth } from '@/lib/model-stats/enkrypt-status';
import {
  AdminSlackNotificationError,
  sendAdminSlackNotification,
} from '@/lib/slack/admin-notifications';
import vercelConfig from '../../../../../vercel.json';
import { GET, maxDuration } from './route';

let mockCronSecret: string | undefined = 'cron-secret';
const mockHealth = jest.mocked(getEnkryptSyncHealth);
const mockRecord = jest.mocked(recordEnkryptSyncAlert);
const mockSlack = jest.mocked(sendAdminSlackNotification);
const sensitive = 'sensitive-header-body-SQL-parameters';
const now = '2026-08-27T12:00:00.000Z';
const counts = {
  fetchedCount: 6,
  rejectedCount: 1,
  matchedCount: 2,
  unmatchedCount: 2,
  ambiguousCount: 1,
  updatedCount: 2,
};

function health(overrides: Partial<EnkryptSyncHealth> = {}): EnkryptSyncHealth {
  return {
    status: 'stale',
    reason: 'stale',
    lastAttemptAt: '2026-08-26T04:00:00.000Z',
    lastSuccessAt: '2026-08-26T04:00:00.000Z',
    counts,
    lastSuccessCounts: counts,
    baselineMatchedCount: 2,
    lastAlertAt: null,
    lastAlertReason: null,
    shouldAlert: true,
    ...overrides,
  };
}

function request(authorization = 'Bearer cron-secret') {
  return new NextRequest('http://localhost/api/cron/check-enkrypt-health', {
    headers: { authorization },
  });
}

function expectSanitized(failure: unknown, category: string) {
  const captured = jest.mocked(captureException).mock.calls[0]?.[0];
  expect(captured).toBeInstanceOf(Error);
  expect(captured).not.toBe(failure);
  expect(captured).toHaveProperty('message', 'Enkrypt health check operation failed');
  expect(captured).not.toHaveProperty('cause');
  if (captured instanceof Error) expect(captured.stack).not.toContain(sensitive);
  expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
    tags: { endpoint: 'cron/check-enkrypt-health', category },
  });
  for (const calls of [
    jest.mocked(captureException).mock.calls,
    jest.mocked(emitScheduledJobEvent).mock.calls,
    mockSlack.mock.calls,
    mockRecord.mock.calls,
  ]) {
    expect(JSON.stringify(calls)).not.toContain(sensitive);
  }
}

describe('GET /api/cron/check-enkrypt-health', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHealth.mockReset().mockResolvedValue(health());
    mockRecord.mockReset().mockResolvedValue(undefined);
    mockSlack.mockReset().mockResolvedValue(undefined);
    mockCronSecret = 'cron-secret';
    jest.replaceProperty(process, 'env', { NODE_ENV: 'test', VERCEL_ENV: 'production' });
    jest.useFakeTimers().setSystemTime(new Date(now));
  });

  afterEach(() => {
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
    expect(mockSlack).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
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
    const response = await GET(request(`Bearer ${secret}`));
    expect(response.status).toBe(401);
    expect(mockHealth).not.toHaveBeenCalled();
    expect(mockSlack).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(createScheduledJobRun).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'healthy'] as const)('returns 200 without alerts when %s', async status => {
    const state = health({ status, reason: null, shouldAlert: false });
    mockHealth.mockResolvedValue(state);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ ...state, delivery: 'not_needed' });
    expect(mockHealth).toHaveBeenCalledTimes(1);
    expect(mockHealth).toHaveBeenCalledWith();
    expect(mockSlack).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        job_name: 'web.check_enkrypt_health',
        outcome: 'succeeded',
        status,
        skipped: status === 'disabled',
        delivery: 'not_needed',
      })
    );
  });

  it.each(['disabled', 'healthy'] as const)(
    'never alerts on %s even if shouldAlert is inconsistent',
    async status => {
      mockHealth.mockResolvedValue(health({ status, shouldAlert: true }));
      expect((await GET(request())).status).toBe(200);
      expect(mockSlack).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
    }
  );

  it.each([
    ...EnkryptFailureCategorySchema.options,
    'stale' as const,
    'never_succeeded' as const,
    'monitor_error' as const,
  ])('sends only a fixed message and safe aggregates for reason %s', async reason => {
    mockHealth.mockResolvedValue(health({ status: 'degraded', reason }));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ...health({ status: 'degraded', reason }),
      delivery: 'sent',
    });
    expect(maxDuration).toBe(60);
    expect(createScheduledJobRun).toHaveBeenCalledWith({
      jobName: 'web.check_enkrypt_health',
      environment: 'production',
    });
    expect(mockSlack).toHaveBeenCalledTimes(1);
    expect(mockSlack).toHaveBeenCalledWith(
      {
        text: `Enkrypt synchronization health alert: ${reason}. Check the Enkrypt sync and health jobs.\n${JSON.stringify(
          {
            status: 'degraded',
            lastAttemptAt: health().lastAttemptAt,
            lastSuccessAt: health().lastSuccessAt,
            counts,
            lastSuccessCounts: counts,
            baselineMatchedCount: 2,
          }
        )}`,
        unfurl_links: false,
        unfurl_media: false,
      },
      { requireConfigured: true }
    );
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(reason, now);
    expect(mockRecord.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockSlack.mock.invocationCallOrder[0]
    );
    expect(captureException).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).toHaveBeenCalledTimes(1);
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        job_name: 'web.check_enkrypt_health',
        outcome: 'failed',
        status: 'degraded',
        reason,
        delivery: 'sent',
        rejected_count: 1,
        matched_count: 2,
        last_success_at: health().lastSuccessAt,
      })
    );
  });

  it.each(['degraded', 'stale', 'never_succeeded', 'unavailable'] as const)(
    'keeps %s unhealthy while duplicate alerts are suppressed',
    async status => {
      mockHealth.mockResolvedValue(
        health({ status, shouldAlert: false, lastAlertAt: now, lastAlertReason: 'stale' })
      );
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status, delivery: 'suppressed' });
      expect(mockSlack).not.toHaveBeenCalled();
      expect(mockRecord).not.toHaveBeenCalled();
      expect(emitScheduledJobEvent).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', delivery: 'suppressed' })
      );
    }
  );

  it('does not alert without an allowlisted reason', async () => {
    mockHealth.mockResolvedValue(health({ reason: null }));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ delivery: 'suppressed' });
    expect(mockSlack).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it.each<NodeJS.ProcessEnv>([
    { NODE_ENV: 'test' },
    { NODE_ENV: 'development' },
    { NODE_ENV: 'production' },
    { NODE_ENV: 'test', VERCEL_ENV: 'preview' },
    { NODE_ENV: 'test', VERCEL_ENV: 'development' },
    { NODE_ENV: 'test', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'staging' },
    { NODE_ENV: 'test', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'preview' },
    { NODE_ENV: 'test', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: '' },
  ])('never delivers or records alerts outside production: %p', async environment => {
    jest.replaceProperty(process, 'env', environment);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'stale', delivery: 'simulated' });
    expect(mockSlack).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(emitScheduledJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', delivery: 'simulated' })
    );
  });

  it('uses the production target over the fallback environment', async () => {
    jest.replaceProperty(process, 'env', {
      NODE_ENV: 'test',
      VERCEL_ENV: 'preview',
      VERCEL_TARGET_ENV: 'production',
    });
    expect((await GET(request())).status).toBe(503);
    expect(mockSlack).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'never_succeeded' as const, reason: 'never_succeeded' as const },
    { status: 'unavailable' as const, reason: 'monitor_error' as const },
  ])('allows alerts without state or database availability: %p', async state => {
    mockHealth.mockResolvedValue(
      health({
        ...state,
        lastAttemptAt: null,
        lastSuccessAt: null,
        counts: null,
        lastSuccessCounts: null,
        baselineMatchedCount: null,
      })
    );
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ...state, delivery: 'sent' });
    expect(mockSlack).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith(state.reason, now);
  });

  it('captures the alert timestamp before delivery completes and records only afterward', async () => {
    let completeDelivery: () => void = () => {
      throw new Error('Slack delivery has not started');
    };
    mockSlack.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          completeDelivery = resolve;
        })
    );
    const responsePromise = GET(request());
    await Promise.resolve();
    expect(mockSlack).toHaveBeenCalledTimes(1);
    expect(mockRecord).not.toHaveBeenCalled();
    jest.setSystemTime(new Date('2026-08-27T12:00:09.000Z'));
    completeDelivery();
    const response = await responsePromise;
    expect(response.status).toBe(503);
    expect(mockRecord).toHaveBeenCalledWith('stale', now);
    expect(await response.json()).toMatchObject({ delivery: 'sent' });
  });

  it.each(['configuration', 'network', 'upstream'] as const)(
    'sanitizes Slack %s failures without recording delivery',
    async category => {
      const failure = Object.assign(new AdminSlackNotificationError(category, 503), {
        message: sensitive,
        stack: sensitive,
        cause: new Error(sensitive),
        headers: sensitive,
        body: sensitive,
      });
      mockSlack.mockRejectedValue(failure);
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ...health(), delivery: 'failed', category });
      expect(mockRecord).not.toHaveBeenCalled();
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(emitScheduledJobEvent).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', category, delivery: 'failed' })
      );
      expectSanitized(failure, category);
    }
  );

  it.each([
    new Error(sensitive),
    { kind: 'configuration', message: sensitive, headers: sensitive },
    Object.assign(new AdminSlackNotificationError('network'), { kind: sensitive }),
  ])('maps unknown Slack failures to unexpected: %p', async failure => {
    mockSlack.mockRejectedValue(failure);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ...health(),
      delivery: 'failed',
      category: 'unexpected',
    });
    expect(mockRecord).not.toHaveBeenCalled();
    expectSanitized(failure, 'unexpected');
  });

  it.each([
    { failure: new EnkryptSyncError('database'), category: 'database' },
    { failure: new Error(sensitive), category: 'unexpected' },
  ])(
    'does not claim recorded delivery when status recording fails: $category',
    async ({ failure, category }) => {
      Object.assign(failure, { message: sensitive, stack: sensitive, cause: new Error(sensitive) });
      mockRecord.mockRejectedValue(failure);
      const response = await GET(request());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ...health(), delivery: 'failed', category });
      expect(mockSlack).toHaveBeenCalledTimes(1);
      expect(mockRecord).toHaveBeenCalledTimes(1);
      expect(emitScheduledJobEvent).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'failed', delivery: 'failed', category })
      );
      expectSanitized(failure, category);
    }
  );

  it.each([
    { failure: new EnkryptSyncError('database'), category: 'database' },
    { failure: new Error(sensitive), category: 'unexpected' },
  ])(
    'reports thrown health reads as unavailable and still alerts: $category',
    async ({ failure, category }) => {
      mockHealth.mockRejectedValue(failure);
      const response = await GET(request());
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({
        status: 'unavailable',
        reason: 'monitor_error',
        delivery: 'sent',
        category,
        lastSuccessAt: null,
        counts: null,
      });
      expect(JSON.stringify(body)).not.toContain(sensitive);
      expect(mockSlack).toHaveBeenCalledTimes(1);
      expect(mockRecord).toHaveBeenCalledWith('monitor_error', now);
      expectSanitized(failure, category);
    }
  );

  it('strips unowned fields from HTTP, Slack, and scheduled metadata', async () => {
    const state = {
      ...health(),
      counts: { ...counts, rawBody: sensitive },
      lastSuccessCounts: { ...counts, sqlParameters: sensitive },
      headers: sensitive,
      upstreamMetadata: sensitive,
    };
    mockHealth.mockResolvedValue(state);
    const response = await GET(request());
    expect(await response.json()).toEqual({ ...health(), delivery: 'sent' });
    expect(JSON.stringify(mockSlack.mock.calls)).not.toContain(sensitive);
    expect(JSON.stringify(jest.mocked(emitScheduledJobEvent).mock.calls)).not.toContain(sensitive);
  });

  it.each([
    { reason: sensitive },
    { status: sensitive },
    { lastSuccessAt: sensitive },
    { lastAlertAt: sensitive },
    { lastAlertReason: sensitive },
    { counts: { ...counts, rejectedCount: sensitive } },
    { lastSuccessCounts: { ...counts, matchedCount: -1 } },
    { baselineMatchedCount: Infinity },
  ])('fails closed on invalid health data without disclosing it: %p', async invalid => {
    mockHealth.mockResolvedValue({ ...health(), ...invalid } as EnkryptSyncHealth);
    const response = await GET(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      status: 'unavailable',
      reason: 'monitor_error',
      delivery: 'sent',
    });
    expect(JSON.stringify(body)).not.toContain(sensitive);
    expectSanitized(invalid, 'unexpected');
  });

  it('schedules an independent hourly health check and preserves daily 04:00 UTC ingestion', () => {
    expect(vercelConfig.crons.filter(cron => cron.path.includes('enkrypt'))).toEqual([
      { path: '/api/cron/sync-enkrypt', schedule: '0 4 * * *' },
      { path: '/api/cron/check-enkrypt-health', schedule: '30 * * * *' },
    ]);
  });
});
