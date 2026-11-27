import { createExecutionContext } from 'cloudflare:test';
import { STS_ISSUERS, type BundleResult } from '@kilocode/sts-contracts';
import { Hono } from 'hono';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Worker from '../src/index';
import {
  ADMIN_ROUTES,
  O11Y_STS_AUDIENCE,
  adminCredentialAcceptance,
  createAdminAuth,
  type AdminRoute,
} from '../src/admin-middleware';
import { serviceClaims, signToken, testSigner, type TestSigner } from './sts-token-fixture';

const ISSUER = STS_ISSUERS.production;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const LEGACY_SECRET = 'legacy-admin-value';

let signer: TestSigner;

beforeAll(async () => {
  signer = await testSigner();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Serves the stand-in key set at the production STS issuer; counts every outbound fetch. */
function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      urls.push(url);
      if (url === JWKS_URL) return Response.json(signer.jwks);
      return new Response('unexpected', { status: 599 });
    })
  );
  return urls;
}

/**
 * An env whose legacy secret can come from either source; `reads` records every Secrets Store
 * read and `bundleCalls` every STS bundle call, so a test can prove the secret was not read.
 * `sinkWrites` records every API-metrics write to Analytics Engine and the pipeline.
 */
function makeEnv(vars: Record<string, string | undefined>) {
  const reads: string[] = [];
  const sinkWrites: string[] = [];
  let bundleCalls = 0;
  const bundle: BundleResult = {
    status: 'ok',
    workload: 'o11y',
    environment: 'production',
    etag: '"0123456789abcdef"',
    stale: false,
    fetchedAt: '2026-11-26T00:00:00.000Z',
    secrets: { O11Y_KILO_GATEWAY_CLIENT_SECRET: { value: LEGACY_SECRET, version: 1 } },
    missing: [],
  };
  const env = {
    O11Y_KILO_GATEWAY_CLIENT_SECRET: {
      async get() {
        reads.push('O11Y_KILO_GATEWAY_CLIENT_SECRET');
        return LEGACY_SECRET;
      },
    },
    O11Y_API_METRICS: {
      writeDataPoint() {
        sinkWrites.push('analytics-engine');
      },
    },
    API_METRICS_STREAM: {
      async send() {
        sinkWrites.push('pipeline');
      },
    },
    STS: {
      async getBundle() {
        bundleCalls += 1;
        return bundle;
      },
    },
    ...vars,
  } as unknown as Env;
  return { env, reads, sinkWrites, bundleCalls: () => bundleCalls };
}

/** Routes behind a fresh guard, so no key set carries over between tests. */
function app() {
  const { requireAdmin } = createAdminAuth();
  const hono = new Hono<{ Bindings: Env }>();
  hono.post('/ingest/api-metrics', requireAdmin('apiMetricsWrite'), c => c.body(null, 204));
  hono.get('/alerting/config', requireAdmin('alertingRead'), c => c.json({ success: true }));
  hono.put('/alerting/config', requireAdmin('alertingWrite'), c => c.json({ success: true }));
  return hono;
}

const PATHS: Record<AdminRoute, { method: string; path: string }> = {
  apiMetricsWrite: { method: 'POST', path: '/ingest/api-metrics' },
  alertingRead: { method: 'GET', path: '/alerting/config' },
  alertingWrite: { method: 'PUT', path: '/alerting/config' },
};

async function call(
  hono: Hono<{ Bindings: Env }>,
  route: AdminRoute,
  env: Env,
  headers: Record<string, string>
) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  };
  const response = await hono.request(
    PATHS[route].path,
    { method: PATHS[route].method, headers },
    env,
    ctx
  );
  await Promise.allSettled(pending);
  return response;
}

/** An o11y token from `workload` for `scope` (default `alertingRead`), signed by `by`. */
async function token(
  overrides: Record<string, unknown> = {},
  workload = 'web',
  scope: string = ADMIN_ROUTES.alertingRead.scope,
  by: TestSigner = signer
) {
  return await signToken(by, {
    ...serviceClaims({ issuer: ISSUER, workload, audience: O11Y_STS_AUDIENCE, scope }),
    ...overrides,
  });
}

describe('the admin route contract', () => {
  it('names the three o11y scopes and their workloads', () => {
    expect(ADMIN_ROUTES).toEqual({
      apiMetricsWrite: { scope: 'o11y:api-metrics.write', workloads: ['ai-gateway', 'web'] },
      alertingRead: { scope: 'o11y:alerting.read', workloads: ['web'] },
      alertingWrite: { scope: 'o11y:alerting.write', workloads: ['web'] },
    });
  });

  it('reads an unset mode as legacy-only and refuses a value outside the closed set', () => {
    expect(adminCredentialAcceptance(undefined)).toEqual({ legacy: true, sts: false });
    expect(adminCredentialAcceptance('')).toEqual({ legacy: true, sts: false });
    expect(adminCredentialAcceptance('sts')).toBeNull();
    expect(adminCredentialAcceptance('LEGACY-ONLY')).toBeNull();
  });
});

describe.each([undefined, 'legacy-only'])('mode %s (the default)', mode => {
  it.each(['secrets-store', 'sts'])(
    'accepts the shared secret from %s and makes no key-set fetch',
    async source => {
      const fetches = stubFetch();
      const { env } = makeEnv({ ADMIN_CREDENTIAL_ACCEPT: mode, SECRETS_SOURCE: source });
      const response = await call(app(), 'apiMetricsWrite', env, {
        'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
      });
      expect(response.status).toBe(204);
      expect(fetches).toEqual([]);
    }
  );

  it('ignores an STS bearer: the legacy check decides, with no key-set fetch', async () => {
    const fetches = stubFetch();
    const { env, reads } = makeEnv({
      ADMIN_CREDENTIAL_ACCEPT: mode,
      STS_ENVIRONMENT: 'production',
    });
    const response = await call(app(), 'alertingRead', env, {
      Authorization: `Bearer ${await token()}`,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: 'Unauthorized' });
    expect(reads).toEqual(['O11Y_KILO_GATEWAY_CLIENT_SECRET']);
    expect(fetches).toEqual([]);
  });

  it('refuses a wrong shared secret as before', async () => {
    stubFetch();
    const { env } = makeEnv({ ADMIN_CREDENTIAL_ACCEPT: mode });
    const response = await call(app(), 'alertingWrite', env, { 'X-O11Y-ADMIN-TOKEN': 'wrong' });
    expect(response.status).toBe(401);
  });
});

describe('a mode outside the set, and disabled', () => {
  it('answers 500 for an unknown mode without reading the secret', async () => {
    const fetches = stubFetch();
    const { env, reads, bundleCalls } = makeEnv({ ADMIN_CREDENTIAL_ACCEPT: 'legacy-or-sts' });
    const response = await call(app(), 'alertingRead', env, {
      'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_misconfigured' });
    expect(reads).toEqual([]);
    expect(bundleCalls()).toBe(0);
    expect(fetches).toEqual([]);
  });

  it('refuses both credentials when disabled', async () => {
    const fetches = stubFetch();
    const { env, reads } = makeEnv({
      ADMIN_CREDENTIAL_ACCEPT: 'disabled',
      STS_ENVIRONMENT: 'production',
    });
    const legacy = await call(app(), 'alertingRead', env, { 'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET });
    const sts = await call(app(), 'alertingRead', env, {
      Authorization: `Bearer ${await token()}`,
    });
    expect([legacy.status, sts.status]).toEqual([401, 401]);
    expect(reads).toEqual([]);
    expect(fetches).toEqual([]);
  });
});

describe.each(['legacy-and-sts', 'sts-only'])('mode %s', mode => {
  const vars = { ADMIN_CREDENTIAL_ACCEPT: mode, STS_ENVIRONMENT: 'production' };

  it.each([
    ['apiMetricsWrite', 'ai-gateway'],
    ['apiMetricsWrite', 'web'],
    ['alertingRead', 'web'],
    ['alertingWrite', 'web'],
  ] as const)('accepts %s from %s without reading the shared secret', async (route, workload) => {
    const fetches = stubFetch();
    const { env, reads, bundleCalls } = makeEnv(vars);
    const response = await call(app(), route, env, {
      Authorization: `Bearer ${await token({}, workload, ADMIN_ROUTES[route].scope)}`,
    });
    expect(response.status).toBeLessThan(300);
    expect(reads).toEqual([]);
    expect(bundleCalls()).toBe(0);
    expect(fetches).toEqual([JWKS_URL]);
  });

  it.each<[string, () => Promise<string>, AdminRoute, number, string]>([
    [
      'a scope of another route',
      () => token({}, 'web', ADMIN_ROUTES.alertingRead.scope),
      'alertingWrite',
      403,
      'insufficient_scope',
    ],
    [
      'another audience',
      () => token({ aud: 'web', scope: 'web:sts.canary' }),
      'alertingRead',
      403,
      'insufficient_scope',
    ],
    [
      'a scope STS does not register',
      () => token({ scope: 'o11y:everything' }),
      'alertingRead',
      403,
      'insufficient_scope',
    ],
    [
      'a workload outside the route allowlist',
      () => token({}, 'ai-gateway', ADMIN_ROUTES.alertingRead.scope),
      'alertingRead',
      403,
      'insufficient_scope',
    ],
    ['another environment', () => token({ env: 'staging' }), 'alertingRead', 401, 'invalid_token'],
    [
      'another issuer',
      () => token({ iss: STS_ISSUERS.staging }),
      'alertingRead',
      401,
      'invalid_token',
    ],
    [
      'an expired token',
      () => {
        const past = Math.floor(Date.now() / 1000) - 3_600;
        return token({ iat: past, exp: past + 300 });
      },
      'alertingRead',
      401,
      'invalid_token',
    ],
    [
      'a forged signature',
      async () => token({}, 'web', undefined, await testSigner(signer.kid)),
      'alertingRead',
      401,
      'invalid_token',
    ],
    [
      'the shared secret sent as a bearer',
      async () => LEGACY_SECRET,
      'alertingRead',
      401,
      'invalid_token',
    ],
  ])(
    'refuses %s and never falls back to the shared secret',
    async (_label, make, route, status, error) => {
      stubFetch();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { env, reads, bundleCalls } = makeEnv(vars);
      const bearer = await make();
      const response = await call(app(), route, env, { Authorization: `Bearer ${bearer}` });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(reads).toEqual([]);
      expect(bundleCalls()).toBe(0);
      const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).toContain('o11y_admin_sts_refused');
      expect(logged).not.toContain(bearer);
    }
  );

  it('refuses a request that carries both credentials without reading the secret', async () => {
    stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, reads } = makeEnv(vars);
    const response = await call(app(), 'alertingRead', env, {
      Authorization: `Bearer ${await token()}`,
      'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
    expect(reads).toEqual([]);
  });

  it('answers 503 with Retry-After while the STS key set is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 502 }))
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, reads } = makeEnv(vars);
    const response = await call(app(), 'alertingRead', env, {
      Authorization: `Bearer ${await token()}`,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
    expect(reads).toEqual([]);
  });

  it('answers 500 when STS_ENVIRONMENT is missing or has no o11y origin', async () => {
    stubFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const environment of [undefined, 'prod', 'staging']) {
      const { env, reads } = makeEnv({
        ADMIN_CREDENTIAL_ACCEPT: mode,
        STS_ENVIRONMENT: environment,
      });
      const response = await call(app(), 'alertingRead', env, {
        Authorization: `Bearer ${await token()}`,
      });
      expect(response.status).toBe(500);
      expect(reads).toEqual([]);
    }
  });
});

describe('the shared secret header without a bearer', () => {
  it('runs the legacy check in legacy-and-sts', async () => {
    const fetches = stubFetch();
    const { env, reads } = makeEnv({
      ADMIN_CREDENTIAL_ACCEPT: 'legacy-and-sts',
      STS_ENVIRONMENT: 'production',
    });
    const response = await call(app(), 'alertingWrite', env, {
      'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
    });
    expect(response.status).toBe(200);
    expect(reads).toEqual(['O11Y_KILO_GATEWAY_CLIENT_SECRET']);
    expect(fetches).toEqual([]);
  });

  it('gets the bare STS challenge in sts-only, without reading the secret', async () => {
    stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env, reads, bundleCalls } = makeEnv({
      ADMIN_CREDENTIAL_ACCEPT: 'sts-only',
      STS_ENVIRONMENT: 'production',
    });
    const response = await call(app(), 'alertingWrite', env, {
      'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://o11y.kiloapps.io/.well-known/oauth-protected-resource"'
    );
    expect(reads).toEqual([]);
    expect(bundleCalls()).toBe(0);
  });
});

describe('GET /.well-known/oauth-protected-resource on the Worker', () => {
  const METADATA_URL = 'https://o11y.kiloapps.io/.well-known/oauth-protected-resource';

  async function get(url: string, vars: Record<string, string | undefined>) {
    const { env, reads, bundleCalls } = makeEnv(vars);
    const response = await new Worker(createExecutionContext(), env).fetch(
      // A caller-chosen Host never reaches the document.
      new Request(url, { headers: { Host: 'attacker.example' } })
    );
    return { response, reads, bundleCalls };
  }

  it.each([
    ['unset', {}],
    ['legacy-only', { ADMIN_CREDENTIAL_ACCEPT: 'legacy-only', STS_ENVIRONMENT: 'production' }],
    ['disabled', { ADMIN_CREDENTIAL_ACCEPT: 'disabled', STS_ENVIRONMENT: 'production' }],
    ['an unknown mode', { ADMIN_CREDENTIAL_ACCEPT: 'sts', STS_ENVIRONMENT: 'production' }],
    ['an STS mode without STS_ENVIRONMENT', { ADMIN_CREDENTIAL_ACCEPT: 'sts-only' }],
    ['an STS mode in staging', { ADMIN_CREDENTIAL_ACCEPT: 'sts-only', STS_ENVIRONMENT: 'staging' }],
    [
      'the api-metrics override without STS_ENVIRONMENT',
      { API_METRICS_CREDENTIAL_ACCEPT: 'sts-only' },
    ],
    [
      'the api-metrics override in staging',
      { API_METRICS_CREDENTIAL_ACCEPT: 'sts-only', STS_ENVIRONMENT: 'staging' },
    ],
    [
      'the api-metrics override disabled',
      { API_METRICS_CREDENTIAL_ACCEPT: 'disabled', STS_ENVIRONMENT: 'production' },
    ],
    [
      'an unknown api-metrics override',
      { API_METRICS_CREDENTIAL_ACCEPT: 'sts', STS_ENVIRONMENT: 'production' },
    ],
    [
      'an unknown mode under a valid api-metrics override',
      {
        ADMIN_CREDENTIAL_ACCEPT: 'sts',
        API_METRICS_CREDENTIAL_ACCEPT: 'sts-only',
        STS_ENVIRONMENT: 'production',
      },
    ],
  ])('answers the ordinary 404 when %s', async (_label, vars) => {
    const fetches = stubFetch();
    const metadata = await get(METADATA_URL, vars);
    const unmatched = await get('https://o11y.kiloapps.io/no-such-route', vars);
    expect(metadata.response.status).toBe(404);
    expect(await metadata.response.text()).toBe(await unmatched.response.text());
    expect(metadata.reads).toEqual([]);
    expect(metadata.bundleCalls()).toBe(0);
    expect(fetches).toEqual([]);
  });

  it.each([
    ['legacy-and-sts', 'production', 'https://o11y.kiloapps.io', STS_ISSUERS.production],
    ['sts-only', 'production', 'https://o11y.kiloapps.io', STS_ISSUERS.production],
    ['sts-only', 'development', 'http://localhost:8801', STS_ISSUERS.development],
  ])(
    'serves the document the %s challenge names in %s, from configuration only',
    async (mode, environment, origin, issuer) => {
      const fetches = stubFetch();
      const vars = { ADMIN_CREDENTIAL_ACCEPT: mode, STS_ENVIRONMENT: environment };
      const { response, reads, bundleCalls } = await get(METADATA_URL, vars);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
      expect(await response.json()).toEqual({
        resource: origin,
        authorization_servers: [issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['o11y:api-metrics.write', 'o11y:alerting.read', 'o11y:alerting.write'],
      });
      expect(reads).toEqual([]);
      expect(bundleCalls()).toBe(0);
      expect(fetches).toEqual([]);

      // The challenge of the same deployment names exactly this document.
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { env } = makeEnv(vars);
      const challenge = await call(app(), 'alertingRead', env, { Authorization: 'Bearer x' });
      expect(challenge.headers.get('www-authenticate')).toContain(
        `resource_metadata="${origin}/.well-known/oauth-protected-resource"`
      );
    }
  );

  it.each([
    [
      'api-metrics sts-only, alerting unset',
      { API_METRICS_CREDENTIAL_ACCEPT: 'sts-only' },
      ['o11y:api-metrics.write'],
    ],
    [
      'api-metrics legacy-and-sts, alerting legacy-only',
      { ADMIN_CREDENTIAL_ACCEPT: 'legacy-only', API_METRICS_CREDENTIAL_ACCEPT: 'legacy-and-sts' },
      ['o11y:api-metrics.write'],
    ],
    [
      'api-metrics rolled back to legacy-only, alerting sts-only',
      { ADMIN_CREDENTIAL_ACCEPT: 'sts-only', API_METRICS_CREDENTIAL_ACCEPT: 'legacy-only' },
      ['o11y:alerting.read', 'o11y:alerting.write'],
    ],
    [
      'an unknown api-metrics override, alerting sts-only',
      { ADMIN_CREDENTIAL_ACCEPT: 'sts-only', API_METRICS_CREDENTIAL_ACCEPT: 'sts' },
      ['o11y:alerting.read', 'o11y:alerting.write'],
    ],
    [
      'an empty api-metrics override, alerting sts-only',
      { ADMIN_CREDENTIAL_ACCEPT: 'sts-only', API_METRICS_CREDENTIAL_ACCEPT: '' },
      ['o11y:api-metrics.write', 'o11y:alerting.read', 'o11y:alerting.write'],
    ],
  ])('lists only the scopes of routes that admit STS: %s', async (_label, modes, scopes) => {
    const fetches = stubFetch();
    const { response, reads, bundleCalls } = await get(METADATA_URL, {
      ...modes,
      STS_ENVIRONMENT: 'production',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resource: 'https://o11y.kiloapps.io',
      authorization_servers: [STS_ISSUERS.production],
      bearer_methods_supported: ['header'],
      scopes_supported: scopes,
    });
    expect(reads).toEqual([]);
    expect(bundleCalls()).toBe(0);
    expect(fetches).toEqual([]);
  });
});

const METRICS_SCOPE = ADMIN_ROUTES.apiMetricsWrite.scope;

/** The STS refusal lines logged so far; each names the route family, status and rule only. */
function refusals(warn: { mock: { calls: unknown[][] } }): unknown[] {
  return warn.mock.calls
    .map(([line]) => String(line))
    .filter(line => line.includes('"o11y_admin_sts_refused"'))
    .map(line => {
      const decoded: unknown = JSON.parse(line);
      return decoded;
    });
}

describe('API_METRICS_CREDENTIAL_ACCEPT, the api-metrics write alone', () => {
  it.each([
    [undefined, 'legacy-only', 204],
    ['', undefined, 204],
    ['', 'sts-only', 401],
  ])(
    'an override of %j follows ADMIN_CREDENTIAL_ACCEPT %j on the shared secret',
    async (override, mode, status) => {
      stubFetch();
      const { env } = makeEnv({
        ADMIN_CREDENTIAL_ACCEPT: mode,
        API_METRICS_CREDENTIAL_ACCEPT: override,
        STS_ENVIRONMENT: 'production',
      });
      const response = await call(app(), 'apiMetricsWrite', env, {
        'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
      });
      expect(response.status).toBe(status);
    }
  );

  it.each(['sts', 'STS-ONLY', 'legacy-or-sts', ' sts-only'])(
    'answers 500 on the api-metrics write for the unknown override %j and leaves alerting alone',
    async override => {
      const fetches = stubFetch();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { env, reads, bundleCalls } = makeEnv({
        API_METRICS_CREDENTIAL_ACCEPT: override,
        STS_ENVIRONMENT: 'production',
      });
      const hono = app();
      const legacy = await call(hono, 'apiMetricsWrite', env, {
        'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
      });
      const sts = await call(hono, 'apiMetricsWrite', env, {
        Authorization: `Bearer ${await token({}, 'ai-gateway', METRICS_SCOPE)}`,
      });
      expect([legacy.status, sts.status]).toEqual([500, 500]);
      expect(await legacy.json()).toEqual({ error: 'server_misconfigured' });
      const logged = error.mock.calls.map(([line]) => {
        const decoded: unknown = JSON.parse(String(line));
        return decoded;
      });
      expect(logged).toEqual([
        { event: 'o11y_admin_auth_misconfigured', reason: 'api_metrics_accept_mode' },
        { event: 'o11y_admin_auth_misconfigured', reason: 'api_metrics_accept_mode' },
      ]);
      expect(reads).toEqual([]);
      expect(bundleCalls()).toBe(0);
      expect(fetches).toEqual([]);

      const alerting = await call(hono, 'alertingRead', env, {
        'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
      });
      expect(alerting.status).toBe(200);
      expect(reads).toEqual(['O11Y_KILO_GATEWAY_CLIENT_SECRET']);
    }
  );

  it('answers 500 for an unknown ADMIN_CREDENTIAL_ACCEPT despite a valid override', async () => {
    const fetches = stubFetch();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env, reads } = makeEnv({
      ADMIN_CREDENTIAL_ACCEPT: 'sts',
      API_METRICS_CREDENTIAL_ACCEPT: 'sts-only',
      STS_ENVIRONMENT: 'production',
    });
    const response = await call(app(), 'apiMetricsWrite', env, {
      Authorization: `Bearer ${await token({}, 'ai-gateway', METRICS_SCOPE)}`,
    });
    expect(response.status).toBe(500);
    const logged = error.mock.calls.map(([line]) => {
      const decoded: unknown = JSON.parse(String(line));
      return decoded;
    });
    expect(logged).toEqual([{ event: 'o11y_admin_auth_misconfigured', reason: 'accept_mode' }]);
    expect(reads).toEqual([]);
    expect(fetches).toEqual([]);
  });

  describe('sts-only for the api-metrics write while alerting stays legacy-only', () => {
    const vars = { API_METRICS_CREDENTIAL_ACCEPT: 'sts-only', STS_ENVIRONMENT: 'production' };

    it.each(['ai-gateway', 'web'])(
      'accepts the api-metrics token from %s without reading the shared secret',
      async workload => {
        const fetches = stubFetch();
        const { env, reads, bundleCalls } = makeEnv(vars);
        const response = await call(app(), 'apiMetricsWrite', env, {
          Authorization: `Bearer ${await token({}, workload, METRICS_SCOPE)}`,
        });
        expect(response.status).toBe(204);
        expect(reads).toEqual([]);
        expect(bundleCalls()).toBe(0);
        expect(fetches).toEqual([JWKS_URL]);
      }
    );

    it.each([
      ['an alerting.read token from web', 'web', ADMIN_ROUTES.alertingRead.scope, 'scope_mismatch'],
      [
        'an alerting.write token from web',
        'web',
        ADMIN_ROUTES.alertingWrite.scope,
        'scope_mismatch',
      ],
      [
        'the metrics scope from usage-ingest',
        'usage-ingest',
        METRICS_SCOPE,
        'workload_not_allowed',
      ],
      ['the metrics scope from o11y itself', 'o11y', METRICS_SCOPE, 'workload_not_allowed'],
    ])(
      'refuses %s with 403 and never reads the shared secret',
      async (_label, workload, scope, reason) => {
        stubFetch();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { env, reads, bundleCalls } = makeEnv(vars);
        const response = await call(app(), 'apiMetricsWrite', env, {
          Authorization: `Bearer ${await token({}, workload, scope)}`,
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: 'insufficient_scope' });
        expect(response.headers.get('www-authenticate')).toContain(`scope="${METRICS_SCOPE}"`);
        expect(refusals(warn)).toEqual([
          { event: 'o11y_admin_sts_refused', route: 'apiMetricsWrite', status: 403, reason },
        ]);
        expect(reads).toEqual([]);
        expect(bundleCalls()).toBe(0);
      }
    );

    it('refuses a staging token: STS_ENVIRONMENT pins the issuer and env claim', async () => {
      stubFetch();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { env, reads } = makeEnv(vars);
      const bearer = await token(
        { env: 'staging', iss: STS_ISSUERS.staging },
        'ai-gateway',
        METRICS_SCOPE
      );
      const response = await call(app(), 'apiMetricsWrite', env, {
        Authorization: `Bearer ${bearer}`,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'invalid_token' });
      expect(reads).toEqual([]);
    });

    it('answers the shared secret alone with the bare challenge, never reading it', async () => {
      const fetches = stubFetch();
      const { env, reads, bundleCalls } = makeEnv(vars);
      const response = await call(app(), 'apiMetricsWrite', env, {
        'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        'Bearer resource_metadata="https://o11y.kiloapps.io/.well-known/oauth-protected-resource"'
      );
      expect(reads).toEqual([]);
      expect(bundleCalls()).toBe(0);
      expect(fetches).toEqual([]);
    });

    it('refuses both credentials together without reading the secret', async () => {
      stubFetch();
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { env, reads } = makeEnv(vars);
      const response = await call(app(), 'apiMetricsWrite', env, {
        Authorization: `Bearer ${await token({}, 'ai-gateway', METRICS_SCOPE)}`,
        'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
      });
      expect(response.status).toBe(400);
      expect(reads).toEqual([]);
    });

    it('keeps the alerting routes on the shared secret, ignoring an STS bearer', async () => {
      const fetches = stubFetch();
      const { env, reads } = makeEnv(vars);
      const hono = app();
      const read = await call(hono, 'alertingRead', env, { 'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET });
      const write = await call(hono, 'alertingWrite', env, { 'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET });
      const bearer = await call(hono, 'alertingRead', env, {
        Authorization: `Bearer ${await token()}`,
      });
      expect([read.status, write.status, bearer.status]).toEqual([200, 200, 401]);
      expect(await bearer.json()).toEqual({ success: false, error: 'Unauthorized' });
      expect(reads).toEqual([
        'O11Y_KILO_GATEWAY_CLIENT_SECRET',
        'O11Y_KILO_GATEWAY_CLIENT_SECRET',
        'O11Y_KILO_GATEWAY_CLIENT_SECRET',
      ]);
      expect(fetches).toEqual([]);
    });

    it.each([undefined, 'staging'])(
      'answers 500 on the api-metrics write alone when STS_ENVIRONMENT is %j',
      async environment => {
        const fetches = stubFetch();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { env, reads } = makeEnv({ ...vars, STS_ENVIRONMENT: environment });
        const hono = app();
        const legacy = await call(hono, 'apiMetricsWrite', env, {
          'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
        });
        const sts = await call(hono, 'apiMetricsWrite', env, {
          Authorization: `Bearer ${await token({}, 'ai-gateway', METRICS_SCOPE)}`,
        });
        expect([legacy.status, sts.status]).toEqual([500, 500]);
        expect(reads).toEqual([]);
        expect(fetches).toEqual([]);
        const alerting = await call(hono, 'alertingRead', env, {
          'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
        });
        expect(alerting.status).toBe(200);
      }
    );
  });

  it('legacy-and-sts admits both credentials on the api-metrics write alone', async () => {
    const fetches = stubFetch();
    const vars = { API_METRICS_CREDENTIAL_ACCEPT: 'legacy-and-sts', STS_ENVIRONMENT: 'production' };
    const hono = app();
    const legacyEnv = makeEnv(vars);
    const legacy = await call(hono, 'apiMetricsWrite', legacyEnv.env, {
      'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
    });
    const stsEnv = makeEnv(vars);
    const sts = await call(hono, 'apiMetricsWrite', stsEnv.env, {
      Authorization: `Bearer ${await token({}, 'ai-gateway', METRICS_SCOPE)}`,
    });
    const alertingEnv = makeEnv(vars);
    const alerting = await call(hono, 'alertingRead', alertingEnv.env, {
      Authorization: `Bearer ${await token()}`,
    });
    expect([legacy.status, sts.status, alerting.status]).toEqual([204, 204, 401]);
    expect(legacyEnv.reads).toEqual(['O11Y_KILO_GATEWAY_CLIENT_SECRET']);
    expect(stsEnv.reads).toEqual([]);
    expect(alertingEnv.reads).toEqual(['O11Y_KILO_GATEWAY_CLIENT_SECRET']);
    expect(fetches).toEqual([JWKS_URL]);
  });

  it('legacy-only rolls the api-metrics write back while alerting stays sts-only', async () => {
    stubFetch();
    const vars = {
      ADMIN_CREDENTIAL_ACCEPT: 'sts-only',
      API_METRICS_CREDENTIAL_ACCEPT: 'legacy-only',
      STS_ENVIRONMENT: 'production',
    };
    const hono = app();
    const metricsEnv = makeEnv(vars);
    const metrics = await call(hono, 'apiMetricsWrite', metricsEnv.env, {
      'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
    });
    const alertingEnv = makeEnv(vars);
    const alerting = await call(hono, 'alertingRead', alertingEnv.env, {
      'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET,
    });
    expect([metrics.status, alerting.status]).toEqual([204, 401]);
    expect(metricsEnv.reads).toEqual(['O11Y_KILO_GATEWAY_CLIENT_SECRET']);
    expect(alertingEnv.reads).toEqual([]);
  });
});

describe('POST /ingest/api-metrics on the Worker with the api-metrics write sts-only', () => {
  const vars = { API_METRICS_CREDENTIAL_ACCEPT: 'sts-only', STS_ENVIRONMENT: 'production' };
  const body = {
    kiloUserId: 'user_123',
    isAnonymous: false,
    isStreaming: true,
    userByok: false,
    provider: 'openai',
    requestedModel: 'kilo-auto/frontier',
    resolvedModel: 'anthropic/claude-sonnet-4.5',
    toolsAvailable: [],
    toolsUsed: [],
    ttfbMs: 45,
    completeRequestMs: 123,
    statusCode: 200,
  };

  /** The deployed route: its own `requireAdmin` guard, validator and sink writes. */
  async function ingest(headers: Record<string, string>) {
    const { env, reads, sinkWrites, bundleCalls } = makeEnv(vars);
    const response = await new Worker(createExecutionContext(), env).fetch(
      new Request('https://o11y.kiloapps.io/ingest/api-metrics', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    );
    return { response, reads, sinkWrites, bundleCalls };
  }

  it('writes the metric for an api-metrics token from the gateway', async () => {
    stubFetch();
    const result = await ingest({
      Authorization: `Bearer ${await token({}, 'ai-gateway', METRICS_SCOPE)}`,
    });
    expect(result.response.status).toBe(204);
    expect(result.sinkWrites).toEqual(['analytics-engine', 'pipeline']);
    expect(result.reads).toEqual([]);
    expect(result.bundleCalls()).toBe(0);
  });

  it.each([
    ['an alerting.write token from web', 'web', ADMIN_ROUTES.alertingWrite.scope, 'scope_mismatch'],
    ['the metrics scope from usage-ingest', 'usage-ingest', METRICS_SCOPE, 'workload_not_allowed'],
  ])('writes nothing for %s', async (_label, workload, scope, reason) => {
    stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await ingest({ Authorization: `Bearer ${await token({}, workload, scope)}` });
    expect(result.response.status).toBe(403);
    expect(refusals(warn)).toEqual([
      { event: 'o11y_admin_sts_refused', route: 'apiMetricsWrite', status: 403, reason },
    ]);
    expect(result.sinkWrites).toEqual([]);
    expect(result.reads).toEqual([]);
  });

  it('writes nothing for the shared secret and never reads it', async () => {
    stubFetch();
    const result = await ingest({ 'X-O11Y-ADMIN-TOKEN': LEGACY_SECRET });
    expect(result.response.status).toBe(401);
    expect(result.sinkWrites).toEqual([]);
    expect(result.reads).toEqual([]);
    expect(result.bundleCalls()).toBe(0);
  });
});
