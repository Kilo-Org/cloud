import { PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH } from '@kilocode/auto-routing-contracts';
import { STS_ISSUERS, STS_SCOPE_REGISTRY } from '@kilocode/sts-contracts';
import { resetInternalAuthObservation } from '@kilocode/worker-utils/internal-auth-observation';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_ROUTING_BENCHMARK_STS_AUDIENCE,
  GOVERNED_ROUTES,
  ROUTE_CONTRACTS,
  adminCredentialAcceptance,
  createAuthMiddleware,
  routeFamily,
  type RouteFamily,
} from './auth';
import type { HonoEnv } from './hono-env';
import { app as workerApp } from './index';
import {
  serviceClaims,
  signToken,
  testSigner,
  type TestSigner,
} from './test-support/sts-token-fixture';

const ISSUER = STS_ISSUERS.production;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const LEGACY_SECRET = 'legacy-internal-value';

/** Main's one item-9 route label, unchanged for both credentials. */
const COUNTER_ROUTE = 'admin_and_client';

const FAMILY_ROUTE: Record<RouteFamily, { method: string; path: string }> = {
  routingTablesRead: { method: 'GET', path: '/admin/routing-table' },
  adminRead: { method: 'GET', path: '/admin/runs/run-1/summaries' },
  adminWrite: { method: 'POST', path: '/admin/runs/run-1/cancel' },
};
const FAMILY_WORKLOAD: Record<RouteFamily, string> = {
  routingTablesRead: 'auto-routing',
  adminRead: 'web',
  adminWrite: 'web',
};
const FAMILIES = Object.keys(FAMILY_ROUTE) as RouteFamily[];
const CLIENT_ROUTE = { method: 'POST', path: '/v1/eval/plan' };

let signer: TestSigner;
let logs: string[];
let fetches: string[];

beforeAll(async () => {
  signer = await testSigner();
});

beforeEach(() => {
  resetInternalAuthObservation();
  logs = [];
  fetches = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      fetches.push(url);
      if (url === JWKS_URL) return Response.json(signer.jwks);
      return new Response('unexpected', { status: 599 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** An env whose legacy secret read is counted, plus the switch settings under test. */
function makeEnv(vars: Record<string, string | undefined> = {}) {
  let secretReads = 0;
  const env = {
    INTERNAL_API_SECRET_PROD: {
      async get() {
        secretReads += 1;
        return LEGACY_SECRET;
      },
    },
    ...vars,
  } as unknown as Env;
  return { env, secretReads: () => secretReads };
}

const DUAL = { ADMIN_CREDENTIAL_ACCEPT: 'legacy-and-sts', STS_ENVIRONMENT: 'production' };
const STS_ONLY = { ADMIN_CREDENTIAL_ACCEPT: 'sts-only', STS_ENVIRONMENT: 'production' };

/** Every governed route and one client route behind a fresh guard. */
function testApp() {
  const hono = new Hono<HonoEnv>();
  hono.use('*', createAuthMiddleware());
  for (const route of GOVERNED_ROUTES) {
    hono.on(route.method, route.path, c => c.json({ ok: true }));
  }
  hono.on(CLIENT_ROUTE.method, CLIENT_ROUTE.path, c => c.json({ ok: true }));
  return hono;
}

async function call(
  hono: Hono<HonoEnv>,
  family: RouteFamily | { method: string; path: string },
  env: Env,
  headers: HeadersInit = {}
) {
  const route = typeof family === 'string' ? FAMILY_ROUTE[family] : family;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  };
  const response = await hono.request(
    `https://auto-routing-benchmark.kiloapps.io${route.path}`,
    { method: route.method, headers },
    env,
    ctx
  );
  await Promise.allSettled(pending);
  return response;
}

/** A service token from `workload` for `family`'s scope, with claim overrides. */
async function token(
  family: RouteFamily,
  overrides: Record<string, unknown> = {},
  workload = FAMILY_WORKLOAD[family]
) {
  return await signToken(signer, {
    ...serviceClaims({
      issuer: ISSUER,
      workload,
      audience: AUTO_ROUTING_BENCHMARK_STS_AUDIENCE,
      scope: ROUTE_CONTRACTS[family].scope,
    }),
    ...overrides,
  });
}

const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

/** The item-9 counter lines written so far, parsed. */
function counterLines() {
  return logs
    .filter(line => line.includes('"kilo_internal_auth"'))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('adminCredentialAcceptance', () => {
  it('reads unset and empty as legacy-only and refuses a value outside the set', () => {
    expect(adminCredentialAcceptance(undefined)).toEqual({ legacy: true, sts: false });
    expect(adminCredentialAcceptance('')).toEqual({ legacy: true, sts: false });
    expect(adminCredentialAcceptance('legacy-and-sts')).toEqual({ legacy: true, sts: true });
    expect(adminCredentialAcceptance('sts-only')).toEqual({ legacy: false, sts: true });
    expect(adminCredentialAcceptance('disabled')).toEqual({ legacy: false, sts: false });
    expect(adminCredentialAcceptance('legacy')).toBeNull();
  });
});

describe('routeFamily', () => {
  it('matches one segment per parameter and HEAD as GET', () => {
    expect(routeFamily('GET', '/admin/runs/abc/summaries')).toBe('adminRead');
    expect(routeFamily('HEAD', '/admin/runs/abc/summaries')).toBe('adminRead');
    expect(routeFamily('POST', '/admin/runs/abc/cancel')).toBe('adminWrite');
    expect(routeFamily('GET', '/admin/runs//summaries')).toBeNull();
    expect(routeFamily('GET', '/admin/runs/a/b/summaries')).toBeNull();
    expect(routeFamily('DELETE', '/admin/config')).toBeNull();
  });
});

describe('legacy-only (the default)', () => {
  it.each(FAMILIES)('admits the shared secret on %s and counts it per route', async family => {
    const { env } = makeEnv();
    const response = await call(testApp(), family, env, bearer(LEGACY_SECRET));
    expect(response.status).toBe(200);
    expect(counterLines()).toEqual([
      expect.objectContaining({
        receiver: 'auto-routing-benchmark',
        route: COUNTER_ROUTE,
        auth: 'legacy_shared_secret',
      }),
    ]);
  });

  it.each(FAMILIES)('refuses a valid STS token on %s without fetching a key set', async family => {
    const { env } = makeEnv();
    const response = await call(testApp(), family, env, bearer(await token(family)));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(fetches).toEqual([]);
  });

  it('keeps the worker answers: wrong and missing secret are 401 on the real app', async () => {
    const { env } = makeEnv();
    for (const headers of [{}, bearer('wrong')]) {
      const response = await workerApp.request(
        'https://auto-routing-benchmark.kiloapps.io/admin/config',
        { headers },
        env
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    }
    expect(fetches).toEqual([]);
  });

  it('keeps the metadata path behind the guard', async () => {
    const { env } = makeEnv();
    const response = await workerApp.request(
      'https://auto-routing-benchmark.kiloapps.io/.well-known/oauth-protected-resource',
      {},
      env
    );
    expect(response.status).toBe(401);
  });
});

describe('legacy-and-sts', () => {
  it.each(FAMILIES)('admits the shared secret alone on %s', async family => {
    const { env } = makeEnv(DUAL);
    const response = await call(testApp(), family, env, bearer(LEGACY_SECRET));
    expect(response.status).toBe(200);
    expect(fetches).toEqual([]);
  });

  it.each(FAMILIES)('admits an STS token alone on %s and logs the sts admission', async family => {
    const { env, secretReads } = makeEnv(DUAL);
    const response = await call(testApp(), family, env, bearer(await token(family)));
    expect(response.status).toBe(200);
    expect(secretReads()).toBe(0);
    const [line] = counterLines();
    expect(Object.keys(line ?? {}).sort()).toEqual(
      ['auth', 'caller', 'count', 'event', 'minute', 'receiver', 'route', 'v'].sort()
    );
    expect(line).toMatchObject({
      event: 'kilo_internal_auth',
      receiver: 'auto-routing-benchmark',
      route: COUNTER_ROUTE,
      auth: 'sts',
      caller: FAMILY_WORKLOAD[family],
      count: 1,
    });
  });

  it.each(['ai-gateway', 'web'])('admits %s on the routing tables', async workload => {
    const { env } = makeEnv(DUAL);
    const sts = await token('routingTablesRead', {}, workload);
    const response = await call(testApp(), 'routingTablesRead', env, bearer(sts));
    expect(response.status).toBe(200);
  });

  it('refuses both credentials together, in either order', async () => {
    const { env, secretReads } = makeEnv(DUAL);
    const sts = await token('adminWrite');
    for (const pair of [
      [LEGACY_SECRET, sts],
      [sts, LEGACY_SECRET],
    ]) {
      const headers = new Headers();
      for (const value of pair) headers.append('authorization', `Bearer ${value}`);
      const response = await call(testApp(), 'adminWrite', env, headers);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
    }
    expect(secretReads()).toBe(0);
    expect(fetches).toEqual([]);
  });

  it('refuses a malformed STS token and never retries it as the secret', async () => {
    const { env, secretReads } = makeEnv(DUAL);
    const response = await call(testApp(), 'adminRead', env, bearer('aaaa.bbbb.cccc'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
    expect(secretReads()).toBe(0);
  });

  it('serves the protected-resource metadata on the real app', async () => {
    const { env } = makeEnv(DUAL);
    const response = await workerApp.request(
      'https://auto-routing-benchmark.kiloapps.io/.well-known/oauth-protected-resource',
      {},
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resource: 'https://auto-routing-benchmark.kiloapps.io',
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: [
        'auto-routing-benchmark:routing-tables.read',
        'auto-routing-benchmark:admin.read',
        'auto-routing-benchmark:admin.write',
      ],
    });
  });
});

describe('sts-only', () => {
  it.each(FAMILIES)('refuses the shared secret on %s without reading it', async family => {
    const { env, secretReads } = makeEnv(STS_ONLY);
    const response = await call(testApp(), family, env, bearer(LEGACY_SECRET));
    expect(response.status).toBe(401);
    expect(secretReads()).toBe(0);
  });

  it('admits an STS token', async () => {
    const { env } = makeEnv(STS_ONLY);
    const response = await call(testApp(), 'adminWrite', env, bearer(await token('adminWrite')));
    expect(response.status).toBe(200);
  });

  it('keeps the shared secret on routes outside /admin/*', async () => {
    const { env } = makeEnv(STS_ONLY);
    const legacy = await call(testApp(), CLIENT_ROUTE, env, bearer(LEGACY_SECRET));
    expect(legacy.status).toBe(200);
    const sts = await call(testApp(), CLIENT_ROUTE, env, bearer(await token('adminRead')));
    expect(sts.status).toBe(401);
  });

  it('refuses an STS token on an /admin path outside the table', async () => {
    const { env } = makeEnv(STS_ONLY);
    const response = await call(
      testApp(),
      { method: 'DELETE', path: '/admin/config' },
      env,
      bearer(await token('adminWrite'))
    );
    expect(response.status).toBe(401);
    expect(fetches).toEqual([]);
  });
});

describe('STS token checks', () => {
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, () => Promise<string>, number][] = [
    ['a wrong audience', () => token('adminWrite', { aud: 'auto-routing' }), 403],
    ['the scope of another route', () => token('adminRead'), 403],
    ['an expired token', () => token('adminWrite', { iat: now - 900, exp: now - 600 }), 401],
    ['a wrong issuer', () => token('adminWrite', { iss: STS_ISSUERS.development }), 401],
    ['another environment', () => token('adminWrite', { env: 'staging' }), 401],
    ['a workload outside the route', () => token('adminWrite', {}, 'ai-gateway'), 403],
  ];

  it.each(cases)('refuses %s on an admin write', async (_name, make, status) => {
    const { env, secretReads } = makeEnv(DUAL);
    const response = await call(testApp(), 'adminWrite', env, bearer(await make()));
    expect(response.status).toBe(status);
    expect(secretReads()).toBe(0);
    expect(counterLines()).toEqual([]);
    // The refusal line alone names the route family and its scope.
    const refusal = logs.find(line => line.includes('"auto_routing_benchmark_sts_refused"'));
    expect(JSON.parse(refusal ?? '{}')).toMatchObject({
      family: 'adminWrite',
      scope: 'auto-routing-benchmark:admin.write',
      status,
    });
  });

  it('requires exactly the scopes STS_SCOPE_REGISTRY lists for this audience', () => {
    expect(STS_SCOPE_REGISTRY[AUTO_ROUTING_BENCHMARK_STS_AUDIENCE]?.scopes).toEqual(
      Object.values(ROUTE_CONTRACTS).map(contract => contract.scope)
    );
  });

  it.each(['web', 'ai-gateway', 'auto-routing'])(
    'refuses a routing-tables.read token from %s on the paid request routing table',
    async workload => {
      const paidTable = { method: 'POST', path: PAID_BENCHMARK_ADMIN_ROUTING_TABLE_PATH };
      expect(routeFamily(paidTable.method, paidTable.path)).toBe('adminRead');
      const { env, secretReads } = makeEnv(DUAL);
      const sts = await token('routingTablesRead', {}, workload);
      const response = await call(testApp(), paidTable, env, bearer(sts));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: 'insufficient_scope',
        scope: ROUTE_CONTRACTS.adminRead.scope,
      });
      expect(secretReads()).toBe(0);
      expect(counterLines()).toEqual([]);
      // The route itself admits its own scope from web.
      const admitted = await call(testApp(), paidTable, env, bearer(await token('adminRead')));
      expect(admitted.status).toBe(200);
    }
  );
});

describe('switch values', () => {
  it('refuses everything under disabled and a value outside the set', async () => {
    for (const [mode, status] of [
      ['disabled', 401],
      ['dual', 500],
    ] as const) {
      const { env } = makeEnv({ ADMIN_CREDENTIAL_ACCEPT: mode });
      const response = await call(testApp(), 'adminWrite', env, bearer(LEGACY_SECRET));
      expect(response.status).toBe(status);
    }
  });

  it('answers 500 for an STS token while STS_ENVIRONMENT is unset', async () => {
    const { env } = makeEnv({ ADMIN_CREDENTIAL_ACCEPT: 'legacy-and-sts' });
    const response = await call(testApp(), 'adminWrite', env, bearer(await token('adminWrite')));
    expect(response.status).toBe(500);
  });
});

describe('route table', () => {
  it('names every registered /admin route of the worker, and nothing else', () => {
    // Hono lists one entry per handler, so a route with a validator appears twice.
    const registered = [
      ...new Set(
        workerApp.routes
          .filter(r => r.method !== 'ALL' && r.path.startsWith('/admin/'))
          .map(r => `${r.method} ${r.path}`)
      ),
    ].sort();
    expect(GOVERNED_ROUTES.map(r => `${r.method} ${r.path}`).sort()).toEqual(registered);
  });
});

describe('logs', () => {
  it('never carry a token or the shared secret', async () => {
    const tokens: string[] = [];
    for (const vars of [{}, DUAL, STS_ONLY]) {
      const { env } = makeEnv(vars);
      for (const family of FAMILIES) {
        const good = await token(family);
        const bad = await token(family, { aud: 'o11y' });
        tokens.push(good, bad);
        for (const value of [LEGACY_SECRET, good, bad, 'wrong']) {
          await call(testApp(), family, env, bearer(value));
        }
      }
    }
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(LEGACY_SECRET);
      for (const value of tokens) expect(line).not.toContain(value.split('.')[2]);
    }
  });
});
