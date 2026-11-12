import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  getExaMonthlyUsage,
  getExaFreeAllowanceMicrodollars,
  recordExaUsage,
} from '@/lib/exa-usage';
import { EXA_USAGE_FALLBACK_TIMEOUT_MS } from '@/lib/exa-usage-fallback';
import { ExaUsageRecordSchema } from '@kilocode/usage-contracts';

let afterCallbacks: (() => Promise<void>)[] = [];

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: (fn: () => Promise<void>) => {
    afterCallbacks.push(fn);
  },
}));

const mockConfig: Record<string, string | undefined> = {};
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  EXA_API_KEY: 'test-exa-key',
  get EXA_USAGE_QUEUE_FALLBACK() {
    return mockConfig.EXA_USAGE_QUEUE_FALLBACK;
  },
  get EXA_USAGE_INGEST_URL() {
    return mockConfig.EXA_USAGE_INGEST_URL;
  },
  get EXA_USAGE_INGEST_PUBLISH_SECRET() {
    return mockConfig.EXA_USAGE_INGEST_PUBLISH_SECRET;
  },
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/exa-usage');
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const INGEST_URL = 'https://ingest.example.test/exa-usage';
const PUBLISH_SECRET = 'synthetic-exa-publisher';
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;
const mockedRecordExaUsage = jest.mocked(recordExaUsage);
let consoleError: jest.SpyInstance;

function upstream() {
  return new Response(JSON.stringify({ results: [], costDollars: { total: 0.007 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function callRoute(...responses: (Response | Error)[]) {
  for (const response of responses.length > 0 ? responses : [upstream()]) {
    if (response instanceof Error) mockedFetch.mockRejectedValueOnce(response);
    else mockedFetch.mockResolvedValueOnce(response);
  }
  const { POST } = await import('./route');
  const response = await POST(
    new Request('http://localhost:3000/api/exa/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'secret-query-text', type: 'deep' }),
    }) as never
  );
  expect(response.status).toBe(200);
  for (const fn of afterCallbacks.splice(0)) await fn();
}

function publishCalls() {
  return mockedFetch.mock.calls.filter(([url]) => url === INGEST_URL);
}

function failureLog() {
  expect(consoleError).toHaveBeenCalledTimes(1);
  return consoleError.mock.calls[0][1] as Record<string, unknown>;
}

function enableFallback() {
  Object.assign(mockConfig, {
    EXA_USAGE_QUEUE_FALLBACK: 'true',
    EXA_USAGE_INGEST_URL: INGEST_URL,
    EXA_USAGE_INGEST_PUBLISH_SECRET: PUBLISH_SECRET,
  });
}

describe('Exa usage queue fallback', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    afterCallbacks = [];
    for (const key of Object.keys(mockConfig)) delete mockConfig[key];
    globalThis.fetch = mockedFetch;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.mocked(getUserFromAuth).mockResolvedValue({
      user: { id: 'user-123' } as User,
      authFailedResponse: null,
      organizationId: undefined,
    });
    jest.mocked(getExaMonthlyUsage).mockResolvedValue({ usage: 0, freeAllowance: null });
    jest.mocked(getExaFreeAllowanceMicrodollars).mockReturnValue(10_000_000);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('never publishes with the flag off, even when the write fails and config is set', async () => {
    Object.assign(mockConfig, {
      EXA_USAGE_INGEST_URL: INGEST_URL,
      EXA_USAGE_INGEST_PUBLISH_SECRET: PUBLISH_SECRET,
    });
    mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));
    await callRoute();
    expect(publishCalls()).toEqual([]);
    expect(failureLog()).toMatchObject({ stage: 'record_write', fallback: 'disabled' });
  });

  it('does not publish after a successful direct write with the flag on', async () => {
    enableFallback();
    mockedRecordExaUsage.mockResolvedValue('recorded');
    await callRoute();
    expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
    expect(publishCalls()).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('publishes the identical record once after a failed direct write, and never writes again', async () => {
    enableFallback();
    mockedRecordExaUsage.mockRejectedValue(
      Object.assign(new Error('connection terminated'), { code: '57P01' })
    );
    await callRoute(upstream(), new Response(null, { status: 202 }));

    expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
    const [[directRecord]] = mockedRecordExaUsage.mock.calls;
    expect(publishCalls()).toHaveLength(1);
    const [[, init]] = publishCalls();
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: `Bearer ${PUBLISH_SECRET}`, 'content-type': 'application/json' },
    });
    const published: unknown = JSON.parse(init?.body as string);
    expect(published).toStrictEqual(directRecord);
    expect(ExaUsageRecordSchema.parse(published)).toStrictEqual(directRecord);
    expect(failureLog()).toEqual({
      exa_path: '/search',
      payer_kind: 'personal',
      charged_to_balance: false,
      cost_microdollars: 7000,
      stage: 'record_write',
      error: { type: 'database', code: '57P01' },
      fallback: 'published',
    });
    expect(EXA_USAGE_FALLBACK_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('logs an ingress 400 as a terminal rejection without another attempt', async () => {
    enableFallback();
    mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));
    await callRoute(upstream(), Response.json({ error: 'Invalid usage payload' }, { status: 400 }));
    expect(publishCalls()).toHaveLength(1);
    expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
    expect(failureLog()).toMatchObject({ fallback: 'rejected', fallback_status: 400 });
  });

  it('skips and logs before any I/O when the flag is on but the publisher is not configured', async () => {
    mockConfig.EXA_USAGE_QUEUE_FALLBACK = 'true';
    mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));
    await callRoute();
    expect(publishCalls()).toEqual([]);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(failureLog()).toMatchObject({ fallback: 'not_configured' });
  });

  it('does not publish when the cost cannot be parsed', async () => {
    enableFallback();
    await callRoute(
      new Response(JSON.stringify({ costDollars: { total: '0.007' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(publishCalls()).toEqual([]);
    expect(failureLog()).toMatchObject({ stage: 'cost_parse' });
    expect(failureLog()).not.toHaveProperty('fallback');
  });

  it('keeps the publish secret and request text out of the failure line', async () => {
    enableFallback();
    mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));
    await callRoute(upstream(), new Error(`${INGEST_URL} ${PUBLISH_SECRET}`));
    expect(failureLog()).toMatchObject({ fallback: 'request_failed', fallback_error: 'Error' });
    const logged = JSON.stringify(consoleError.mock.calls);
    for (const value of [PUBLISH_SECRET, INGEST_URL, 'secret-query-text'])
      expect(logged).not.toContain(value);
  });
});
