import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
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

const mockWaitUntil = jest.fn<void, [Promise<unknown>]>();
jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: (promise: Promise<unknown>) => mockWaitUntil(promise),
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
const STAGING = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' };
const PREVIEW = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' };
const LOCAL = {};
const PRODUCTION_URL = 'https://o11y.kiloapps.io';
const LOCAL_URL = 'http://localhost:8801';
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

type Runtime = Partial<Record<'VERCEL_ENV' | 'VERCEL_TARGET_ENV', string>>;
const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV'] as const;
const savedRuntime = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>();

function setRuntime(values: Runtime): void {
  for (const name of runtimeNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * A fresh sender module: it resolves its switch from configuration when it loads. Also returns
 * that registry's `ServiceTokenError`, the class its STS module checks errors against.
 */
async function loadSender(config: {
  auth?: string;
  secret?: string;
  url?: string;
  runtime?: Runtime;
}) {
  setRuntime(config.runtime ?? PRODUCTION);
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
    O11Y_SERVICE_URL: config.url ?? PRODUCTION_URL,
    O11Y_KILO_GATEWAY_CLIENT_SECRET: config.secret ?? SECRET,
    O11Y_API_METRICS_SENDER_AUTH: config.auth ?? '',
  }));
  const sender = await import('./api-metrics.server');
  const { ServiceTokenError } = await import('@kilocode/service-token-client');
  jest.dontMock('@kilocode/web-shared/lib/config.server');
  return { sender, ServiceTokenError };
}

/** Runs what the emitters deferred with `after`, as Next.js does once the response is sent. */
async function runDeferred(): Promise<number> {
  const tasks = mockAfter.mock.calls.map(([task]) =>
    typeof task === 'function' ? (task as () => Promise<unknown>)() : task
  );
  mockAfter.mockClear();
  await Promise.all(tasks);
  return tasks.length;
}

function sentHeaders(call = 0): Headers {
  return new Headers(mockFetch.mock.calls[call]?.[1]?.headers);
}

function sentTarget(): string | undefined {
  const target = mockFetch.mock.calls[0]?.[0];
  if (target instanceof URL) return target.href;
  return typeof target === 'string' ? target : target?.url;
}

let consoleError: jest.SpyInstance;
let consoleInfo: jest.SpyInstance;

beforeEach(() => {
  mockAfter.mockReset();
  mockWaitUntil.mockReset();
  mockTokenGet.mockReset();
  mockCreateHttpServiceTokens.mockClear();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
  globalThis.fetch = mockFetch as typeof fetch;
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleInfo = jest.spyOn(console, 'info').mockImplementation(() => {});
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

  test.each(['dual', 'STS', 'Legacy', ' sts', 'sts ', 'true', 'legacy-and-sts', 'off'])(
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
    ).toEqual({ kind: 'off', reason: 'unconfigured' });
  });

  test('sts on Vercel production sends only to the production o11y origin', () => {
    expect(
      resolveApiMetricsSender({ auth: 'sts', url, secret: SECRET, runtime: PRODUCTION })
    ).toEqual({ kind: 'sts', url, environment: 'production' });
    for (const other of [
      'https://o11y.example.test/ingest/api-metrics',
      'https://o11y.kiloapps.io:8443/ingest/api-metrics',
      `${LOCAL_URL}/ingest/api-metrics`,
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

  test.each([
    ['staging', STAGING],
    ['a preview', PREVIEW],
    ['production with another target', { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'staging' }],
    ['Vercel development', { VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development' }],
  ])('sts is production only: %s sends nothing', (_name, runtime) => {
    expect(resolveApiMetricsSender({ auth: 'sts', url, secret: SECRET, runtime })).toEqual({
      kind: 'off',
      reason: 'sts_production_only',
    });
  });

  test('a process outside Vercel maps to development STS and the local o11y origin', () => {
    const local = new URL(`${LOCAL_URL}/ingest/api-metrics`);
    expect(
      resolveApiMetricsSender({ auth: 'sts', url: local, secret: '', runtime: LOCAL })
    ).toEqual({ kind: 'sts', url: local, environment: 'development' });
    expect(resolveApiMetricsSender({ auth: 'sts', url, secret: '', runtime: LOCAL })).toEqual({
      kind: 'misconfigured',
      reason: 'origin_mismatch',
    });
  });
});

describe('api metrics sender, legacy', () => {
  test.each([undefined, '', 'legacy'])(
    'O11Y_API_METRICS_SENDER_AUTH=%j sends the shared secret in X-O11Y-ADMIN-TOKEN, exactly as before',
    async auth => {
      const { sender } = await loadSender({ auth });
      sender.emitGatewayApiMetrics(params);
      expect(await runDeferred()).toBe(1);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const init = mockFetch.mock.calls[0]?.[1];
      expect(sentTarget()).toBe(`${PRODUCTION_URL}/ingest/api-metrics`);
      expect(init).toEqual({
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-O11Y-ADMIN-TOKEN': SECRET },
        body: JSON.stringify(params),
        redirect: 'error',
      });
      expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
      expect(mockTokenGet).not.toHaveBeenCalled();
    }
  );
});

describe('api metrics sender, sts', () => {
  test('sends only an o11y:api-metrics.write token from production STS, never the configured secret', async () => {
    mockTokenGet.mockResolvedValue(TOKEN);
    const { sender } = await loadSender({ auth: 'sts', secret: SECRET });
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

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentTarget()).toBe(`${PRODUCTION_URL}/ingest/api-metrics`);
    const headers = sentHeaders();
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.has('X-O11Y-ADMIN-TOKEN')).toBe(false);
    expect(JSON.stringify([...headers])).not.toContain(SECRET);
    expect(mockFetch.mock.calls[0]?.[1]?.body).not.toContain(SECRET);
    expect(mockFetch.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  test('sends without the shared secret configured', async () => {
    mockTokenGet.mockResolvedValue(TOKEN);
    const { sender } = await loadSender({ auth: 'sts', secret: '' });
    sender.emitApiMetricsForResponse(params, Promise.resolve(null), performance.now());
    await runDeferred();

    expect(sentHeaders().get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  test('a local process mints from development STS for the local o11y origin', async () => {
    mockTokenGet.mockResolvedValue(TOKEN);
    const { sender } = await loadSender({ auth: 'sts', url: LOCAL_URL, runtime: LOCAL });
    sender.emitApiMetrics(params);
    await runDeferred();

    expect(mockCreateHttpServiceTokens.mock.calls[0]?.[0].stsUrl).toBe(STS_ISSUERS.development);
    expect(sentTarget()).toBe(`${LOCAL_URL}/ingest/api-metrics`);
  });

  test('one token client serves every send of the process', async () => {
    mockTokenGet.mockResolvedValue(TOKEN);
    const { sender } = await loadSender({ auth: 'sts' });
    sender.emitApiMetrics(params);
    sender.emitApiMetrics(params);
    await runDeferred();

    expect(mockCreateHttpServiceTokens).toHaveBeenCalledTimes(1);
    expect(mockTokenGet).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('a cold send does not wait for a mint: it drops the metric and renews in the background', async () => {
    const mint = Promise.withResolvers<string>();
    mockTokenGet.mockReturnValue(mint.promise);
    const { sender } = await loadSender({ auth: 'sts' });

    sender.emitApiMetrics(params);
    const startedAt = performance.now();
    expect(await runDeferred()).toBe(1);
    expect(performance.now() - startedAt).toBeLessThan(100);

    // Nothing sent and the read left running under waitUntil.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTokenGet).toHaveBeenCalledTimes(1);
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);

    // While that read waits, later sends drop at once without asking the client again.
    sender.emitApiMetrics(params);
    sender.emitApiMetrics(params);
    expect(await runDeferred()).toBe(2);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTokenGet).toHaveBeenCalledTimes(1);
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();

    // The renewal lands; the next send finds the held token.
    mint.resolve(TOKEN);
    await mockWaitUntil.mock.calls[0]?.[0];
    mockTokenGet.mockResolvedValue(TOKEN);
    sender.emitApiMetrics(params);
    await runDeferred();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentHeaders().get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(consoleInfo).not.toHaveBeenCalled();
  });

  test('a mint outage logs once on entry and once on recovery, with the count dropped', async () => {
    const { sender, ServiceTokenError } = await loadSender({ auth: 'sts' });
    mockTokenGet.mockRejectedValue(
      new ServiceTokenError(
        { reason: 'unavailable', retryAfterSeconds: 4 },
        STS_O11Y_API_METRICS_WRITE
      )
    );
    for (let i = 0; i < 3; i++) sender.emitApiMetrics(params);
    await runDeferred();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'o11y api metrics: no STS token; dropping metrics until one is held',
      { errorName: 'ServiceTokenError', reason: 'unavailable', droppedBefore: 0 }
    );

    mockTokenGet.mockResolvedValue(TOKEN);
    sender.emitApiMetrics(params);
    sender.emitApiMetrics(params);
    await runDeferred();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(consoleInfo).toHaveBeenCalledWith(
      'o11y api metrics: STS token held again; sending metrics',
      { dropped: 3, failingMs: expect.any(Number) }
    );

    // A second outage logs again.
    mockTokenGet.mockRejectedValue(
      new Error('no Vercel token for the STS audience: secret detail')
    );
    sender.emitApiMetrics(params);
    await runDeferred();
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenLastCalledWith(
      'o11y api metrics: no STS token; dropping metrics until one is held',
      { errorName: 'Error', droppedBefore: 0 }
    );
  });

  test.each([
    ['a denied mint', 'denied'],
    ['an unavailable STS', 'unavailable'],
    ['a failed Vercel identity', 'identity'],
  ] as const)(
    '%s fails closed: nothing sent, never the secret, no message logged',
    async (_name, kind) => {
      const { sender, ServiceTokenError } = await loadSender({ auth: 'sts' });
      const failure =
        kind === 'denied'
          ? new ServiceTokenError(
              { reason: 'denied', deniedReason: 'scope_not_allowed' },
              STS_O11Y_API_METRICS_WRITE
            )
          : kind === 'unavailable'
            ? new ServiceTokenError(
                { reason: 'unavailable', retryAfterSeconds: 4 },
                STS_O11Y_API_METRICS_WRITE
              )
            : new Error('no Vercel token for the STS audience: exchange answered 500');
      mockTokenGet.mockRejectedValue(failure);
      sender.emitApiMetrics(params);
      await runDeferred();

      expect(mockFetch).not.toHaveBeenCalled();
      const expected =
        kind === 'denied'
          ? { errorName: 'ServiceTokenError', reason: 'denied', deniedReason: 'scope_not_allowed' }
          : kind === 'unavailable'
            ? { errorName: 'ServiceTokenError', reason: 'unavailable' }
            : { errorName: 'Error' };
      expect(consoleError).toHaveBeenCalledWith(
        'o11y api metrics: no STS token; dropping metrics until one is held',
        { ...expected, droppedBefore: 0 }
      );
      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).not.toContain(failure.message);
      expect(logged).not.toContain(SECRET);
    }
  );
});

describe('api metrics sender, sends nothing', () => {
  test.each([
    ['sts on staging', { auth: 'sts', runtime: STAGING }],
    ['sts on a preview', { auth: 'sts', runtime: PREVIEW }],
  ])('%s is a quiet off: one note on the first metric, not at load', async (_name, config) => {
    const { sender } = await loadSender(config);
    expect(consoleInfo).not.toHaveBeenCalled();

    sender.emitApiMetrics(params);
    sender.emitGatewayApiMetrics(params);
    sender.emitApiMetricsForResponse(params, Promise.resolve(null), performance.now());

    expect(await runDeferred()).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockTokenGet).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledTimes(1);
    expect(consoleInfo).toHaveBeenCalledWith(
      'o11y api metrics: sts is production only; sending nothing on this deployment'
    );
  });

  test.each([
    ['an invalid switch value', { auth: 'dual' }, 'invalid_auth'],
    ['sts to another origin', { auth: 'sts', url: 'https://o11y.example.test' }, 'origin_mismatch'],
  ] as const)(
    '%s sends nothing and says why once, on the first metric',
    async (_name, config, reason) => {
      const { sender } = await loadSender(config);
      expect(consoleError).not.toHaveBeenCalled();

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
    }
  );
});
