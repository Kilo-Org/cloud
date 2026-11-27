import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { ServiceTokenError } from '@kilocode/service-token-client';
import { STS_ISSUERS, STS_O11Y_API_METRICS_WRITE } from '@kilocode/sts-contracts';
import { resolveApiMetricsSender } from './api-metrics-sender';
import type { ApiMetricsParams } from './api-metrics.server';

// The sender end to end in one process: the real switch, the real lazy STS module and the shared
// token module, with the token client, the Vercel identity and the network faked.

const mockAfter = jest.fn<void, [unknown]>();
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: (task: unknown) => mockAfter(task),
}));

jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: jest.fn(),
}));

const mockIdentity = jest.fn(async () => 'exchanged-identity-token');
jest.mock('@kilocode/service-token-client/vercel', () => ({
  vercelIdentity: jest.fn(() => mockIdentity),
}));

const mockTokenGet = jest.fn<Promise<string>, [unknown, unknown]>();
const mockCreateHttpServiceTokens = jest.fn((_options: { stsUrl: string }) => ({
  get: mockTokenGet,
}));
jest.mock('@kilocode/service-token-client', () => ({
  ...(jest.requireActual('@kilocode/service-token-client') as Record<string, unknown>),
  createHttpServiceTokens: (options: { stsUrl: string }) => mockCreateHttpServiceTokens(options),
}));

const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' };
const PRODUCTION_URL = 'https://o11y.kiloapps.io';
const SECRET = 'legacy-o11y-secret';
const TOKEN = 'sts-service-token';

const params: ApiMetricsParams = {
  kiloUserId: 'user-1',
  isAnonymous: false,
  isStreaming: false,
  userByok: false,
  provider: 'openrouter',
  requestedModel: 'test-model',
  resolvedModel: 'test-model',
  toolsAvailable: [],
  toolsUsed: [],
  ttfbMs: 10,
  completeRequestMs: 20,
  statusCode: 200,
};

const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV'] as const;
const savedRuntime = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>();

function setRuntime(values: Partial<Record<(typeof runtimeNames)[number], string>>): void {
  for (const name of runtimeNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** A fresh sender module: it resolves its switch from configuration when it loads. */
async function loadSender(config: {
  auth?: string;
  secret?: string;
  url?: string;
  runtime?: Partial<Record<(typeof runtimeNames)[number], string>>;
}) {
  setRuntime(config.runtime ?? PRODUCTION);
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
    O11Y_SERVICE_URL: config.url ?? PRODUCTION_URL,
    O11Y_KILO_GATEWAY_CLIENT_SECRET: config.secret ?? SECRET,
    O11Y_API_METRICS_SENDER_AUTH: config.auth ?? '',
  }));
  const loaded = await import('./api-metrics.server');
  jest.dontMock('@kilocode/web-shared/lib/config.server');
  return loaded;
}

/** Runs what the emitters deferred with `after`, as Next.js does once the response is sent. */
async function runDeferred(): Promise<number> {
  const tasks = mockAfter.mock.calls.map(([task]) =>
    typeof task === 'function' ? (task as () => Promise<unknown>)() : task
  );
  await Promise.all(tasks);
  return tasks.length;
}

function sentHeaders(): Headers {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return new Headers(mockFetch.mock.calls[0]?.[1]?.headers);
}

function sentTarget(): string | undefined {
  const target = mockFetch.mock.calls[0]?.[0];
  if (target instanceof URL) return target.href;
  return typeof target === 'string' ? target : target?.url;
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockAfter.mockReset();
  mockTokenGet.mockReset();
  mockCreateHttpServiceTokens.mockClear();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
  globalThis.fetch = mockFetch as typeof fetch;
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntime(savedRuntime);
  jest.restoreAllMocks();
});

describe('O11Y_API_METRICS_SENDER_AUTH', () => {
  const url = new URL(`${PRODUCTION_URL}/ingest/api-metrics`);

  test.each([undefined, '', 'legacy'])('%j selects the shared secret', auth => {
    expect(resolveApiMetricsSender({ auth, url, secret: SECRET, runtime: PRODUCTION })).toEqual({
      kind: 'legacy',
      url,
      secret: SECRET,
    });
  });

  test.each(['dual', 'STS', ' sts', 'sts ', 'true', 'legacy-and-sts', 'off'])(
    'rejects %j and sends nothing',
    auth => {
      expect(resolveApiMetricsSender({ auth, url, secret: SECRET, runtime: PRODUCTION })).toEqual({
        kind: 'misconfigured',
        reason: 'invalid_auth',
      });
    }
  );

  test('legacy without the secret sends nothing, as before the switch', () => {
    expect(
      resolveApiMetricsSender({ auth: 'legacy', url, secret: '', runtime: PRODUCTION })
    ).toEqual({ kind: 'off' });
  });

  test('sts sends from production only to the production o11y origin', () => {
    expect(
      resolveApiMetricsSender({ auth: 'sts', url, secret: SECRET, runtime: PRODUCTION })
    ).toEqual({ kind: 'sts', url, environment: 'production' });
    for (const other of [
      'https://o11y.example.test/ingest/api-metrics',
      'https://o11y.kiloapps.io:8443/ingest/api-metrics',
      'http://localhost:8801/ingest/api-metrics',
    ]) {
      expect(
        resolveApiMetricsSender({
          auth: 'sts',
          url: new URL(other),
          secret: '',
          runtime: PRODUCTION,
        })
      ).toEqual({ kind: 'misconfigured', reason: 'origin_mismatch' });
    }
  });

  test('sts on staging sends nothing: o11y has no staging origin', () => {
    expect(
      resolveApiMetricsSender({
        auth: 'sts',
        url,
        secret: SECRET,
        runtime: { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' },
      })
    ).toEqual({ kind: 'misconfigured', reason: 'no_o11y_origin' });
  });

  test('sts on a deployment with no STS environment sends nothing', () => {
    expect(
      resolveApiMetricsSender({
        auth: 'sts',
        url,
        secret: SECRET,
        runtime: { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'staging' },
      })
    ).toEqual({ kind: 'misconfigured', reason: 'no_sts_environment' });
  });
});

describe('api metrics sender', () => {
  test('legacy sends the shared secret in X-O11Y-ADMIN-TOKEN, exactly as before', async () => {
    const sender = await loadSender({ auth: '' });
    sender.emitGatewayApiMetrics(params);
    expect(await runDeferred()).toBe(1);

    const init = mockFetch.mock.calls[0]?.[1];
    expect(sentTarget()).toBe(`${PRODUCTION_URL}/ingest/api-metrics`);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'X-O11Y-ADMIN-TOKEN': SECRET,
    });
    expect(JSON.parse(init?.body as string)).toEqual(params);
    expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
    expect(mockTokenGet).not.toHaveBeenCalled();
  });

  test('sts sends only an o11y:api-metrics.write token from production STS', async () => {
    mockTokenGet.mockResolvedValue(TOKEN);
    const sender = await loadSender({ auth: 'sts' });
    sender.emitApiMetrics(params);
    expect(await runDeferred()).toBe(1);

    expect(mockCreateHttpServiceTokens).toHaveBeenCalledTimes(1);
    expect(mockCreateHttpServiceTokens.mock.calls[0]?.[0].stsUrl).toBe(STS_ISSUERS.production);
    expect(mockTokenGet).toHaveBeenCalledTimes(1);
    expect(mockTokenGet.mock.calls[0]?.[0]).toEqual({
      audience: 'o11y',
      scope: 'o11y:api-metrics.write',
    });
    expect(mockTokenGet.mock.calls[0]?.[0]).toEqual(STS_O11Y_API_METRICS_WRITE);

    const headers = sentHeaders();
    expect(sentTarget()).toBe(`${PRODUCTION_URL}/ingest/api-metrics`);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('X-O11Y-ADMIN-TOKEN')).toBeNull();
    expect(JSON.stringify([...headers])).not.toContain(SECRET);
    expect(mockFetch.mock.calls[0]?.[1]?.body).not.toContain(SECRET);
  });

  test('sts sends without the shared secret configured', async () => {
    mockTokenGet.mockResolvedValue(TOKEN);
    const sender = await loadSender({ auth: 'sts', secret: '' });
    sender.emitApiMetricsForResponse(params, Promise.resolve(null), performance.now());
    await runDeferred();

    expect(sentHeaders().get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  test('one token client serves every send of the process', async () => {
    mockTokenGet.mockResolvedValue(TOKEN);
    const sender = await loadSender({ auth: 'sts' });
    sender.emitApiMetrics(params);
    sender.emitApiMetrics(params);
    await runDeferred();

    expect(mockCreateHttpServiceTokens).toHaveBeenCalledTimes(1);
    expect(mockTokenGet).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test.each([
    [
      'a denied mint',
      new ServiceTokenError(
        { reason: 'denied', deniedReason: 'scope_not_allowed' },
        STS_O11Y_API_METRICS_WRITE
      ),
    ],
    [
      'an unavailable STS',
      new ServiceTokenError(
        { reason: 'unavailable', retryAfterSeconds: 4 },
        STS_O11Y_API_METRICS_WRITE
      ),
    ],
    [
      'a failed Vercel identity',
      new Error('no Vercel token for the STS audience: exchange answered 500'),
    ],
  ])('%s fails closed: nothing sent, never the shared secret', async (_name, failure) => {
    mockTokenGet.mockRejectedValue(failure);
    const sender = await loadSender({ auth: 'sts' });
    sender.emitApiMetrics(params);
    await expect(runDeferred()).resolves.toBe(1);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('o11y api metrics: no STS token; metric not sent', {
      errorName: failure.name,
      message: failure.message,
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(SECRET);
  });

  test.each([
    ['an invalid switch value', { auth: 'dual' }, 'invalid_auth'],
    [
      'sts on staging',
      { auth: 'sts', runtime: { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' } },
      'no_o11y_origin',
    ],
    ['sts to another origin', { auth: 'sts', url: 'https://o11y.example.test' }, 'origin_mismatch'],
  ] as const)('%s sends nothing and says why once', async (_name, config, reason) => {
    const sender = await loadSender(config);
    sender.emitApiMetrics(params);
    sender.emitGatewayApiMetrics(params);
    sender.emitApiMetricsForResponse(params, Promise.resolve(null), performance.now());

    expect(await runDeferred()).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTokenGet).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'o11y api metrics: invalid sender configuration; sending nothing',
      { reason }
    );
  });
});
