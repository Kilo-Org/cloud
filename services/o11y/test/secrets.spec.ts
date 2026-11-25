import {
  SecretUnavailableError,
  type BundleBinding,
  type SecretsExecutionContext,
} from '@kilocode/secrets-client';
import type { BundleRequest, BundleResult } from '@kilocode/sts-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireAdmin } from '../src/admin-middleware';
import { queryContainerAllocations } from '../src/alerting/container-allocations';
import { queryContainerApplications } from '../src/alerting/container-capacity-query';
import { sendAlertNotification, type SloAlertPayload } from '../src/alerting/notify';
import { queryErrorRates } from '../src/alerting/query';
import { queryQueueBacklog } from '../src/alerting/queue-backlog-query';
import { resolveQueueId } from '../src/alerting/queue-lookup';
import {
  SecretNotConfiguredError,
  readO11ySecret,
  secretsSource,
  type O11ySecretName,
} from '../src/secrets';

const ETAG = '"0123456789abcdef"';
const CONTAINERS_TOKEN = 'O11Y_CF_CONTAINERS_API_TOKEN';
const SECRET_NAMES: readonly O11ySecretName[] = [
  'O11Y_KILO_GATEWAY_CLIENT_SECRET',
  'O11Y_CF_AE_API_TOKEN',
  'O11Y_SLACK_WEBHOOK_PAGE',
  'O11Y_SLACK_WEBHOOK_TICKET',
  'O11Y_CF_CONTAINERS_API_TOKEN',
];

function storeSecret(value: string, reads: string[], name: string): SecretsStoreSecret {
  return {
    async get() {
      reads.push(name);
      return value;
    },
  } as SecretsStoreSecret;
}

function storeEnv(values: Partial<Record<O11ySecretName, string>>) {
  const reads: string[] = [];
  const env: Partial<Record<O11ySecretName, SecretsStoreSecret>> = {};
  for (const name of SECRET_NAMES) {
    const value = values[name];
    if (value !== undefined) env[name] = storeSecret(value, reads, name);
  }
  return { env, reads };
}

function bundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
  return {
    status: 'ok',
    workload: 'o11y',
    environment: 'production',
    etag: ETAG,
    stale: false,
    fetchedAt: '2026-11-25T00:00:00.000Z',
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

function stsBinding(result: BundleResult) {
  const requests: BundleRequest[] = [];
  const binding: BundleBinding = {
    async getBundle(request) {
      requests.push(request);
      return result;
    },
  };
  return { requests, binding };
}

describe('secretsSource', () => {
  it('defaults to the Secrets Store', () => {
    expect(secretsSource({})).toBe('secrets-store');
  });

  it('accepts sts', () => {
    expect(secretsSource({ SECRETS_SOURCE: 'sts' })).toBe('sts');
  });

  it('fails closed on an unknown source', () => {
    expect(() => secretsSource({ SECRETS_SOURCE: 'infisical-direct' })).toThrow(/SECRETS_SOURCE/);
  });
});

describe('readO11ySecret', () => {
  it('reads the Secrets Store binding by default', async () => {
    const { env, reads } = storeEnv({
      [CONTAINERS_TOKEN]: 'store-token',
      O11Y_CF_AE_API_TOKEN: 'ae-token',
    });

    expect(await readO11ySecret(env, CONTAINERS_TOKEN)).toBe('store-token');
    expect(reads).toEqual([CONTAINERS_TOKEN]);
  });

  it('reads the STS bundle when the source is sts', async () => {
    const { env, reads } = storeEnv({ [CONTAINERS_TOKEN]: 'store-token' });
    const { binding, requests } = stsBinding(bundle({ [CONTAINERS_TOKEN]: 'bundle-token' }));

    const resolved = await readO11ySecret(
      { ...env, SECRETS_SOURCE: 'sts', STS: binding },
      CONTAINERS_TOKEN
    );

    expect(resolved).toBe('bundle-token');
    expect(reads).toEqual([]);
    expect(requests).toEqual([{}]);
  });

  it('rolls back to the Secrets Store when the source flips back', async () => {
    const { env, reads } = storeEnv({ [CONTAINERS_TOKEN]: 'store-token' });
    const { binding } = stsBinding(bundle({ [CONTAINERS_TOKEN]: 'bundle-token' }));

    expect(
      await readO11ySecret({ ...env, SECRETS_SOURCE: 'sts', STS: binding }, CONTAINERS_TOKEN)
    ).toBe('bundle-token');
    expect(
      await readO11ySecret(
        { ...env, SECRETS_SOURCE: 'secrets-store', STS: binding },
        CONTAINERS_TOKEN
      )
    ).toBe('store-token');
    expect(reads).toEqual([CONTAINERS_TOKEN]);
  });

  it('reuses one bundle across reads and env objects in an isolate', async () => {
    const { binding, requests } = stsBinding(
      bundle({ [CONTAINERS_TOKEN]: 'bundle-token', O11Y_CF_AE_API_TOKEN: 'bundle-ae' })
    );

    expect(await readO11ySecret({ SECRETS_SOURCE: 'sts', STS: binding }, CONTAINERS_TOKEN)).toBe(
      'bundle-token'
    );
    expect(
      await readO11ySecret({ SECRETS_SOURCE: 'sts', STS: binding }, 'O11Y_CF_AE_API_TOKEN')
    ).toBe('bundle-ae');
    expect(requests).toHaveLength(1);
  });

  it('surfaces a non-retryable failure for a granted name the manager does not hold', async () => {
    const { binding } = stsBinding(bundle({}, [CONTAINERS_TOKEN]));
    const error = await readO11ySecret(
      { SECRETS_SOURCE: 'sts', STS: binding },
      CONTAINERS_TOKEN
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SecretUnavailableError);
    expect(error).toMatchObject({ reason: 'missing', retryable: false });
  });

  it('requires the STS binding when the source is sts', async () => {
    await expect(readO11ySecret({ SECRETS_SOURCE: 'sts' }, CONTAINERS_TOKEN)).rejects.toThrow(
      /STS service binding is missing/
    );
  });

  it('refuses to read from an unknown source', async () => {
    const { env, reads } = storeEnv({ [CONTAINERS_TOKEN]: 'store-token' });
    const { binding, requests } = stsBinding(bundle({ [CONTAINERS_TOKEN]: 'bundle-token' }));

    await expect(
      readO11ySecret({ ...env, SECRETS_SOURCE: 'vault', STS: binding }, CONTAINERS_TOKEN)
    ).rejects.toThrow(/SECRETS_SOURCE/);
    expect(reads).toEqual([]);
    expect(requests).toEqual([]);
  });

  it('reports an unconfigured Secrets Store value with the secret name', async () => {
    const { env } = storeEnv({ [CONTAINERS_TOKEN]: '' });
    await expect(readO11ySecret(env, CONTAINERS_TOKEN)).rejects.toThrow(
      `${CONTAINERS_TOKEN} secret is not configured`
    );
  });
});

describe('every o11y secret read site over the STS source', () => {
  const stop = new Error('request captured');

  function stsOnlyEnv() {
    const { env: store, reads } = storeEnv(
      Object.fromEntries(SECRET_NAMES.map(name => [name, `store-${name}`]))
    );
    const { binding } = stsBinding(
      bundle(
        Object.fromEntries(
          SECRET_NAMES.map(name => [
            name,
            name.startsWith('O11Y_SLACK_WEBHOOK')
              ? `https://hooks.slack.com/${name}`
              : `bundle-${name}`,
          ])
        )
      )
    );
    const env = {
      ...store,
      SECRETS_SOURCE: 'sts',
      STS: binding,
      O11Y_CF_ACCOUNT_ID: 'account',
    } as unknown as Env;
    return { env, reads };
  }

  function capturingFetch() {
    const requests: { url: string; authorization: string | null }[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      throw stop;
    };
    return { requests, fetchFn };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks the admin token against the bundle value', async () => {
    const { env, reads } = stsOnlyEnv();
    const app = new Hono<{ Bindings: Env }>().get('/admin', requireAdmin, c => c.text('ok'));
    const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };

    const allowed = await app.request(
      '/admin',
      { headers: { 'X-O11Y-ADMIN-TOKEN': 'bundle-O11Y_KILO_GATEWAY_CLIENT_SECRET' } },
      env,
      executionCtx
    );
    const refused = await app.request(
      '/admin',
      { headers: { 'X-O11Y-ADMIN-TOKEN': 'store-O11Y_KILO_GATEWAY_CLIENT_SECRET' } },
      env,
      executionCtx
    );

    expect(allowed.status).toBe(200);
    expect(refused.status).toBe(401);
    expect(reads).toEqual([]);
  });

  it.each(['secrets-store', 'sts'] as const)(
    'refuses an empty admin header when the %s value is empty',
    async source => {
      const name = 'O11Y_KILO_GATEWAY_CLIENT_SECRET';
      const { env: store } = storeEnv({ [name]: '' });
      const { binding } = stsBinding(bundle({ [name]: '' }));
      const env = { ...store, SECRETS_SOURCE: source, STS: binding } as unknown as Env;
      const app = new Hono<{ Bindings: Env }>().get('/admin', requireAdmin, c => c.text('ok'));
      const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };

      const withEmpty = await app.request(
        '/admin',
        { headers: { 'X-O11Y-ADMIN-TOKEN': '' } },
        env,
        executionCtx
      );
      const withoutHeader = await app.request('/admin', {}, env, executionCtx);

      expect(withEmpty.status).toBe(401);
      expect(withoutHeader.status).toBe(401);
      await expect(readO11ySecret(env, name)).rejects.toThrow(SecretNotConfiguredError);
      await expect(readO11ySecret(env, name)).rejects.toThrow(`${name} secret is not configured`);
    }
  );

  it('queries Analytics Engine with the bundle token', async () => {
    const { env, reads } = stsOnlyEnv();
    const { requests, fetchFn } = capturingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFn);

    await expect(queryErrorRates(5, 1, env)).rejects.toBe(stop);
    expect(requests[0]?.authorization).toBe(['Bearer', 'bundle-O11Y_CF_AE_API_TOKEN'].join(' '));
    expect(reads).toEqual([]);
  });

  it.each([
    ['page', 'O11Y_SLACK_WEBHOOK_PAGE'],
    ['ticket', 'O11Y_SLACK_WEBHOOK_TICKET'],
  ] as const)('posts a %s alert to the bundle webhook', async (severity, name) => {
    const { env, reads } = stsOnlyEnv();
    const { requests, fetchFn } = capturingFetch();
    vi.spyOn(globalThis, 'fetch').mockImplementation(fetchFn);
    const alert: SloAlertPayload = {
      alertType: 'error_rate',
      severity,
      provider: 'openai',
      model: 'gpt-4',
      clientName: 'kilo-gateway',
      burnRate: 14.5,
      burnRateThreshold: 14.4,
      windowMinutes: 5,
      totalRequests: 10000,
      slo: 0.999,
      currentRate: 0.0145,
    };

    await expect(sendAlertNotification(alert, env)).rejects.toBe(stop);
    expect(requests[0]?.url).toBe(`https://hooks.slack.com/${name}`);
    expect(reads).toEqual([]);
  });

  it.each([
    [
      'container capacity',
      (env: Env, fetchFn: typeof fetch) => queryContainerApplications(env, fetchFn),
    ],
    [
      'container allocations',
      (env: Env, fetchFn: typeof fetch) => queryContainerAllocations(env, fetchFn),
    ],
    ['queue backlog', (env: Env, fetchFn: typeof fetch) => queryQueueBacklog(env, fetchFn)],
    [
      'queue lookup',
      (env: Env, fetchFn: typeof fetch) => resolveQueueId(env, fetchFn, 'kilo-alerts'),
    ],
  ] as const)('calls the %s API with the bundle token', async (_site, query) => {
    const { env, reads } = stsOnlyEnv();
    const { requests, fetchFn } = capturingFetch();

    await expect(query(env, fetchFn)).rejects.toBe(stop);
    expect(requests[0]?.authorization).toBe(['Bearer', `bundle-${CONTAINERS_TOKEN}`].join(' '));
    expect(reads).toEqual([]);
  });

  it.each([
    [
      'container capacity',
      (env: Env, fetchFn: typeof fetch, ctx: SecretsExecutionContext) =>
        queryContainerApplications(env, fetchFn, ctx),
    ],
    [
      'container allocations',
      (env: Env, fetchFn: typeof fetch, ctx: SecretsExecutionContext) =>
        queryContainerAllocations(env, fetchFn, ctx),
    ],
    [
      'queue backlog',
      (env: Env, fetchFn: typeof fetch, ctx: SecretsExecutionContext) =>
        queryQueueBacklog(env, fetchFn, undefined, ctx),
    ],
    [
      'queue lookup',
      (env: Env, fetchFn: typeof fetch, ctx: SecretsExecutionContext) =>
        resolveQueueId(env, fetchFn, 'kilo-alerts', ctx),
    ],
  ] as const)('keeps the %s read revalidation alive with the run context', async (_site, query) => {
    const { env } = stsOnlyEnv();
    const { fetchFn } = capturingFetch();
    const scheduled: Promise<unknown>[] = [];
    const ctx: SecretsExecutionContext = {
      waitUntil(promise) {
        scheduled.push(promise);
      },
    };

    await expect(query(env, fetchFn, ctx)).rejects.toBe(stop);
    expect(scheduled).toEqual([]);

    // Past the 240 s revalidation age the read serves the held bundle and revalidates in the
    // background, which only the context it was given keeps alive.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 241_000 });
    try {
      await expect(query(env, fetchFn, ctx)).rejects.toBe(stop);
    } finally {
      vi.useRealTimers();
    }
    expect(scheduled).toHaveLength(1);
    await scheduled[0];
  });
});
