// Do not import `jest` from '@jest/globals': the SWC transform hoists these `jest.mock` calls only
// with the global `jest`.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INTERNAL_API_SECRET: 'env-only-secret',
  BOUNCER_URL: 'https://bouncer.example.com',
  NOTIFICATIONS_WORKER_URL: 'https://notifications.example.com',
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'https://benchmark.example.com',
}));

jest.mock('@kilocode/web-shared/lib/constants', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/constants'),
  APP_URL: 'https://app.example.com',
}));

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { captureException } from '@sentry/nextjs';
import type { InternalDispatchSpendAlertRequest } from '@kilocode/notifications/schemas';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import * as z from 'zod';
import {
  registerOwnerBenchmarkProfiles,
  requestPaidBenchmarkQuote,
} from './ai-gateway/auto-routing-benchmark-admin-client';
import { createWorkerAdminFetch } from './ai-gateway/worker-admin-fetch';
import { recordUsageInPrimaryRegion } from './ai-gateway/usage-record-client';
import { deliverCreditEventWireBody } from './bouncer/client';
import { installInternalApiSecretRead } from './internal-api-secret';
import { dispatchSpendAlertPush } from './notifications-worker-client';

// Each shared sender keeps its own header and failure contract: an app (web or AI gateway)
// installs its read; a process with nothing installed keeps its configured value whatever
// SECRETS_SOURCE says.

const DELIVERED = 'sts-delivered-secret';
const installedRead = jest.fn<Promise<string>, []>();
const fetchMock = jest.fn<Promise<Response>, Parameters<typeof fetch>>();

function sentHeader(name: string): string | null {
  const init = fetchMock.mock.calls[0]?.[1];
  return new Headers(init?.headers).get(name);
}

function denial(): Error {
  return Object.assign(new Error('STS denied the bundle request for this workload'), {
    name: 'SecretUnavailableError',
  });
}

const spendAlert: Omit<InternalDispatchSpendAlertRequest, 'kind'> = {
  recipientUserIds: ['user-1'],
  scope: 'organization',
  organizationId: 'org-1',
  alertKind: 'threshold',
  scopeName: 'Acme',
  amountUsd: 5,
  thresholdUsd: 5,
  dedupeKey: 'org:org-1:threshold:push:2026-01-01T00:00:00.000Z:armed',
};

// The handoff refuses before it serializes the payload, so its shape does not matter here.
const usageRecord = {} as UsageRecordRequest;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SECRETS_SOURCE;
  installedRead.mockResolvedValue(DELIVERED);
  globalThis.__kilocodeInternalApiSecretRead = undefined;
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockImplementation(async () => Response.json({ perRecipient: [] }));
});

afterEach(() => {
  delete process.env.SECRETS_SOURCE;
  globalThis.__kilocodeInternalApiSecretRead = undefined;
});

describe.each([
  ['a process with nothing installed and an unrelated SECRETS_SOURCE', false, 'env-only-secret'],
  ['an app with the installed read', true, DELIVERED],
])('in %s', (_name, installed, expected) => {
  beforeEach(() => {
    if (installed) installInternalApiSecretRead(installedRead);
    else process.env.SECRETS_SOURCE = 'sts';
  });

  it('bouncer sends x-internal-api-key', async () => {
    await expect(deliverCreditEventWireBody({ eventId: 'e-1' })).resolves.toMatchObject({
      delivered: true,
    });
    expect(sentHeader('x-internal-api-key')).toBe(expected);
  });

  it('notifications sends X-Internal-Secret', async () => {
    await expect(dispatchSpendAlertPush(spendAlert)).resolves.toBe(true);
    expect(sentHeader('x-internal-secret')).toBe(expected);
  });

  it('worker admin calls send a bearer', async () => {
    fetchMock.mockImplementation(async () => Response.json({ ok: true }));
    const fetchAdmin = createWorkerAdminFetch({
      workerUrl: 'https://worker.example.com',
      unconfiguredError: 'Worker is not configured',
    });
    await fetchAdmin('adminRead', '/admin/x', { method: 'GET' }, z.object({ ok: z.literal(true) }));
    expect(sentHeader('authorization')).toBe(`Bearer ${expected}`);
  });
});

describe('when STS cannot deliver the secret', () => {
  beforeEach(() => {
    installInternalApiSecretRead(installedRead);
    installedRead.mockRejectedValue(denial());
  });

  it('bouncer sends nothing and reports a retryable failure, not a missing configuration', async () => {
    await expect(deliverCreditEventWireBody({ eventId: 'e-1' })).resolves.toEqual({
      delivered: false,
      permanent: false,
      status: null,
      error: 'SecretUnavailableError',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('notifications sends nothing, never rejects, and captures the failure', async () => {
    await expect(dispatchSpendAlertPush(spendAlert)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('the primary-region usage handoff sends nothing and falls back to the local write', async () => {
    await expect(recordUsageInPrimaryRegion(usageRecord)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'internal_api_secret_unavailable',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a worker admin call answers its not-configured result without a request or reason', async () => {
    const fetchAdmin = createWorkerAdminFetch({
      workerUrl: 'https://worker.example.com',
      unconfiguredError: 'Worker is not configured',
    });
    await expect(
      fetchAdmin('adminRead', '/admin/x', { method: 'GET' }, z.object({ ok: z.literal(true) }))
    ).resolves.toEqual({ status: 500, body: { error: 'Worker is not configured' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('benchmark profile registration answers not configured without a request', async () => {
    await expect(
      registerOwnerBenchmarkProfiles({
        router: 'efficient',
        ownerType: 'user',
        ownerId: 'user-1',
        entries: [],
      })
    ).resolves.toEqual({
      ok: false,
      status: 500,
      error: { error: 'Auto routing benchmark worker is not configured' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a paid benchmark call answers not_configured without a request', async () => {
    // Refused before the body is serialized, so its shape does not matter here.
    const quote = {} as Parameters<typeof requestPaidBenchmarkQuote>[0];
    await expect(requestPaidBenchmarkQuote(quote)).resolves.toEqual({
      ok: false,
      status: 500,
      error: { code: 'not_configured', message: 'Auto routing benchmark worker is not configured' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

it('an empty delivered secret keeps the missing-configuration answer', async () => {
  installInternalApiSecretRead(installedRead);
  installedRead.mockResolvedValue('');
  await expect(deliverCreditEventWireBody({ eventId: 'e-1' })).resolves.toEqual({
    delivered: false,
    permanent: true,
    status: null,
    error: 'bouncer_not_configured',
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
