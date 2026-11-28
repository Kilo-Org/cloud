import { STS_ISSUERS, STS_SCOPE_REGISTRY, type StsScopeRegistry } from '@kilocode/sts-contracts';
import { resetInternalAuthObservation } from '@kilocode/worker-utils/internal-auth-observation';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTO_ROUTING_STS_AUDIENCE,
  GOVERNED_ROUTES,
  ROUTE_CONTRACTS,
  createAuthMiddleware,
  internalCredentialAcceptance,
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

/** The pending scopes, registered the way igor/sts-c1-scopes registers them. */
const REGISTRY: StsScopeRegistry = {
  ...STS_SCOPE_REGISTRY,
  [AUTO_ROUTING_STS_AUDIENCE]: {
    scopes: Object.values(ROUTE_CONTRACTS).map(contract => contract.scope),
  },
};

const FAMILY_ROUTE: Record<RouteFamily, { method: string; path: string }> = {
  adminRead: { method: 'GET', path: '/admin/classifier-model' },
  adminWrite: { method: 'PUT', path: '/admin/routing-mode' },
  decide: { method: 'POST', path: '/decide' },
};
const FAMILY_WORKLOAD: Record<RouteFamily, string> = {
  adminRead: 'web',
  adminWrite: 'web',
  decide: 'ai-gateway',
};
const FAMILIES = Object.keys(FAMILY_ROUTE) as RouteFamily[];

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

const DUAL = { INTERNAL_CREDENTIAL_ACCEPT: 'legacy-and-sts', STS_ENVIRONMENT: 'production' };
const STS_ONLY = { INTERNAL_CREDENTIAL_ACCEPT: 'sts-only', STS_ENVIRONMENT: 'production' };

/** Every governed route behind a fresh guard, so no key set carries over between tests. */
function testApp(registry: StsScopeRegistry | null = REGISTRY) {
  const hono = new Hono<HonoEnv>();
  hono.use('*', createAuthMiddleware(registry ? { scopeRegistry: registry } : {}));
  for (const route of GOVERNED_ROUTES) {
    hono.on(route.method, route.path, c => c.json({ ok: true }));
  }
  hono.get('/health', c => c.json({ ok: true }));
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
    `https://auto-routing.kiloapps.io${route.path}`,
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
      audience: AUTO_ROUTING_STS_AUDIENCE,
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

describe('internalCredentialAcceptance', () => {
  it('reads unset and empty as legacy-only and refuses a value outside the set', () => {
    expect(internalCredentialAcceptance(undefined)).toEqual({ legacy: true, sts: false });
    expect(internalCredentialAcceptance('')).toEqual({ legacy: true, sts: false });
    expect(internalCredentialAcceptance('legacy-and-sts')).toEqual({ legacy: true, sts: true });
    expect(internalCredentialAcceptance('sts-only')).toEqual({ legacy: false, sts: true });
    expect(internalCredentialAcceptance('disabled')).toEqual({ legacy: false, sts: false });
    expect(internalCredentialAcceptance('dual')).toBeNull();
  });
});

describe('legacy-only (the default)', () => {
  it.each(FAMILIES)('admits the shared secret on %s and counts it per route', async family => {
    const { env } = makeEnv();
    const response = await call(testApp(), family, env, bearer(LEGACY_SECRET));
    expect(response.status).toBe(200);
    expect(counterLines()).toEqual([
      expect.objectContaining({
        receiver: 'auto-routing',
        route: ROUTE_CONTRACTS[family].label,
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
        'https://auto-routing.kiloapps.io/admin/classifier-model',
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
      'https://auto-routing.kiloapps.io/.well-known/oauth-protected-resource',
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
      receiver: 'auto-routing',
      route: ROUTE_CONTRACTS[family].label,
      auth: 'sts',
      caller: FAMILY_WORKLOAD[family],
      count: 1,
    });
  });

  it('refuses both credentials together, in either order', async () => {
    const { env, secretReads } = makeEnv(DUAL);
    const sts = await token('decide');
    for (const pair of [
      [LEGACY_SECRET, sts],
      [sts, LEGACY_SECRET],
    ]) {
      const headers = new Headers();
      for (const value of pair) headers.append('authorization', `Bearer ${value}`);
      const response = await call(testApp(), 'decide', env, headers);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid_request' });
    }
    expect(secretReads()).toBe(0);
    expect(fetches).toEqual([]);
  });

  it('refuses a malformed STS token and never retries it as the secret', async () => {
    const { env, secretReads } = makeEnv(DUAL);
    const response = await call(testApp(), 'decide', env, bearer('aaaa.bbbb.cccc'));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('invalid_token');
    expect(secretReads()).toBe(0);
  });

  it('refuses a wrong secret that is not a JWS as before', async () => {
    const { env } = makeEnv(DUAL);
    const response = await call(testApp(), 'decide', env, bearer('wrong'));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('serves the protected-resource metadata on the real app', async () => {
    const { env } = makeEnv(DUAL);
    const response = await workerApp.request(
      'https://auto-routing.kiloapps.io/.well-known/oauth-protected-resource',
      {},
      env
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resource: 'https://auto-routing.kiloapps.io',
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: [
        'auto-routing:admin.read',
        'auto-routing:admin.write',
        'auto-routing:decide',
      ],
    });
  });

  it('answers 500 for an STS token while STS_ENVIRONMENT is unset', async () => {
    const { env } = makeEnv({ INTERNAL_CREDENTIAL_ACCEPT: 'legacy-and-sts' });
    const response = await call(testApp(), 'decide', env, bearer(await token('decide')));
    expect(response.status).toBe(500);
  });
});

describe('sts-only', () => {
  it.each(FAMILIES)('refuses the shared secret on %s without reading it', async family => {
    const { env, secretReads } = makeEnv(STS_ONLY);
    const response = await call(testApp(), family, env, bearer(LEGACY_SECRET));
    expect(response.status).toBe(401);
    expect(secretReads()).toBe(0);
  });

  it('challenges a request without a credential', async () => {
    const { env } = makeEnv(STS_ONLY);
    const response = await call(testApp(), 'decide', env);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://auto-routing.kiloapps.io/.well-known/oauth-protected-resource"'
    );
  });

  it('admits an STS token', async () => {
    const { env } = makeEnv(STS_ONLY);
    const response = await call(testApp(), 'adminWrite', env, bearer(await token('adminWrite')));
    expect(response.status).toBe(200);
  });

  it('keeps the shared secret on /health', async () => {
    const { env } = makeEnv(STS_ONLY);
    const response = await call(
      testApp(),
      { method: 'GET', path: '/health' },
      env,
      bearer(LEGACY_SECRET)
    );
    expect(response.status).toBe(200);
  });
});

describe('STS token checks', () => {
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, () => Promise<string>, number][] = [
    ['a wrong audience', () => token('decide', { aud: 'o11y' }), 403],
    ['the scope of another route', () => token('adminRead', {}, 'ai-gateway'), 403],
    ['an expired token', () => token('decide', { iat: now - 900, exp: now - 600 }), 401],
    ['a wrong issuer', () => token('decide', { iss: STS_ISSUERS.development }), 401],
    ['another environment', () => token('decide', { env: 'staging' }), 401],
    ['a workload outside the route', () => token('decide', {}, 'web'), 403],
  ];

  it.each(cases)('refuses %s on decide', async (_name, make, status) => {
    const { env, secretReads } = makeEnv(DUAL);
    const response = await call(testApp(), 'decide', env, bearer(await make()));
    expect(response.status).toBe(status);
    expect(secretReads()).toBe(0);
    expect(counterLines()).toEqual([]);
  });

  it('refuses the pending scopes while the default registry lacks them', async () => {
    const { env } = makeEnv(DUAL);
    const response = await call(testApp(null), 'decide', env, bearer(await token('decide')));
    expect(response.status).toBe(403);
  });
});

describe('switch values', () => {
  it('refuses everything under disabled and a value outside the set', async () => {
    for (const [mode, status] of [
      ['disabled', 401],
      ['dual', 500],
    ] as const) {
      const { env } = makeEnv({ INTERNAL_CREDENTIAL_ACCEPT: mode });
      const response = await call(testApp(), 'decide', env, bearer(LEGACY_SECRET));
      expect(response.status).toBe(status);
    }
  });
});

describe('route table', () => {
  it('names every registered /admin and /decide route of the worker, and nothing else', () => {
    // Hono lists one entry per handler, so a route with a validator appears twice.
    const registered = [
      ...new Set(
        workerApp.routes
          .filter(r => r.method !== 'ALL' && (r.path.startsWith('/admin/') || r.path === '/decide'))
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
