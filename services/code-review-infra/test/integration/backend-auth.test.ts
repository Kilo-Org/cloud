import { env } from 'cloudflare:test';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import { resetInternalAuthObservation } from '@kilocode/worker-utils/internal-auth-observation';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../../src/index';
import {
  CODE_REVIEW_STS_AUDIENCE,
  REVIEW_ROUTES,
  backendCredentialAcceptance,
  createBackendAuth,
  type ReviewRouteName,
} from '../../src/backend-auth';
import type { Env } from '../../src/types';
import { serviceClaims, signToken, testSigner, type TestSigner } from './sts-token-fixture';

const ISSUER = STS_ISSUERS.production;
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;
const SECRET = 'synthetic-backend-token';
const ORIGIN = 'https://kilo-code-review-worker.engineering-e11.workers.dev';
const METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource`;
const ROUTE_NAMES: readonly ReviewRouteName[] = ['dispatch', 'statusRead', 'cancel', 'retryFresh'];

let signer: TestSigner;

beforeAll(async () => {
  signer = await testSigner();
});

beforeEach(() => {
  resetInternalAuthObservation();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Serves the stand-in key set at the production STS issuer; records every outbound fetch. */
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

/** The test env with `vars`; `reads` counts every read of the shared secret. */
function makeEnv(vars: Record<string, string | undefined>) {
  let reads = 0;
  const testEnv = {
    ...env,
    BACKEND_AUTH_TOKEN: {
      async get() {
        reads += 1;
        return SECRET;
      },
    },
    ...vars,
  } as unknown as Env;
  return { env: testEnv, reads: () => reads };
}

/** One request per route; each admitted request gets the route's own answer to this input. */
const REQUESTS: Record<ReviewRouteName, { method: string; path: string; admitted: number }> = {
  dispatch: { method: 'POST', path: '/review', admitted: 400 },
  statusRead: { method: 'GET', path: '/reviews/review-auth-test/status', admitted: 404 },
  cancel: { method: 'POST', path: '/reviews/review-auth-test/cancel', admitted: 400 },
  retryFresh: { method: 'POST', path: '/reviews/review-auth-test/retry-fresh', admitted: 400 },
};

async function call(
  target: { request: Hono<{ Bindings: Env }>['request'] },
  route: ReviewRouteName,
  testEnv: Env,
  headers: HeadersInit
) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  };
  const { method, path } = REQUESTS[route];
  const response = await target.request(
    path,
    // An invalid body: an admitted request stops at the handler's own validation.
    { method, headers, body: method === 'POST' ? 'not json' : undefined },
    testEnv,
    ctx
  );
  await Promise.allSettled(pending);
  return response;
}

/** A `code-review` token from `workload` for `route`'s scope, signed by `by`. */
async function token(
  route: ReviewRouteName = 'dispatch',
  overrides: Record<string, unknown> = {},
  workload = 'web',
  by: TestSigner = signer
) {
  return await signToken(by, {
    ...serviceClaims({
      issuer: ISSUER,
      workload,
      audience: CODE_REVIEW_STS_AUDIENCE,
      scope: REVIEW_ROUTES[route].scope,
    }),
    ...overrides,
  });
}

/** Every `kilo_internal_auth` line logged so far, parsed. */
function authLines(log: { mock: { calls: unknown[][] } }) {
  return log.mock.calls
    .map(([line]) => String(line))
    .filter(line => line.includes('"kilo_internal_auth"'))
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('the review route contract', () => {
  it('names one scope per route', () => {
    expect(Object.fromEntries(ROUTE_NAMES.map(name => [name, REVIEW_ROUTES[name].scope]))).toEqual({
      dispatch: 'code-review:review.dispatch',
      statusRead: 'code-review:review.status-read',
      cancel: 'code-review:review.cancel',
      retryFresh: 'code-review:review.retry-fresh',
    });
    expect(CODE_REVIEW_STS_AUDIENCE).toBe('code-review');
  });

  it('registers each review route in index.ts under its contract method and path', () => {
    const registered = app.routes
      .filter(route => route.method !== 'ALL')
      .map(route => `${route.method} ${route.path}`);
    for (const name of ROUTE_NAMES) {
      expect(registered).toContain(`${REVIEW_ROUTES[name].method} ${REVIEW_ROUTES[name].path}`);
    }
  });

  it('reads an unset or empty mode as legacy-only and refuses a value outside the set', () => {
    expect(backendCredentialAcceptance(undefined)).toEqual({ legacy: true, sts: false });
    expect(backendCredentialAcceptance('')).toEqual({ legacy: true, sts: false });
    expect(backendCredentialAcceptance('sts')).toBeNull();
    expect(backendCredentialAcceptance('LEGACY-ONLY')).toBeNull();
  });
});

describe.each([undefined, '', 'legacy-only'])('mode %j (the default)', mode => {
  const vars = { BACKEND_CREDENTIAL_ACCEPT: mode, STS_ENVIRONMENT: 'production' };

  it.each(ROUTE_NAMES)('admits the shared secret on %s, counted per route', async route => {
    const fetches = stubFetch();
    const log = vi.spyOn(console, 'log');
    const { env: testEnv } = makeEnv(vars);
    const response = await call(app, route, testEnv, {
      Authorization: `Bearer ${SECRET}`,
      'x-kilo-caller': 'web',
    });
    expect(response.status).toBe(REQUESTS[route].admitted);
    expect(fetches).toEqual([]);
    expect(authLines(log)).toEqual([
      expect.objectContaining({
        receiver: 'code-review-infra',
        route: REVIEW_ROUTES[route].label,
        auth: 'legacy_shared_secret',
        caller: 'web',
      }),
    ]);
  });

  it('refuses an STS token as before, with no key-set fetch', async () => {
    const fetches = stubFetch();
    const { env: testEnv } = makeEnv(vars);
    const response = await call(app, 'dispatch', testEnv, {
      Authorization: `Bearer ${await token()}`,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(fetches).toEqual([]);
  });

  it('refuses a wrong or missing secret as before', async () => {
    stubFetch();
    const { env: testEnv } = makeEnv(vars);
    for (const headers of [{ Authorization: 'Bearer wrong' }, {}]) {
      const response = await call(app, 'cancel', testEnv, headers);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    }
  });

  it('keeps the metadata path an ordinary unmatched path', async () => {
    const fetches = stubFetch();
    const { env: testEnv } = makeEnv(vars);
    const anonymous = await app.request('/.well-known/oauth-protected-resource', {}, testEnv);
    const authorized = await app.request(
      '/.well-known/oauth-protected-resource',
      { headers: { Authorization: `Bearer ${SECRET}` } },
      testEnv
    );
    expect([anonymous.status, authorized.status]).toEqual([401, 404]);
    expect(fetches).toEqual([]);
  });
});

describe('a mode outside the set, and disabled', () => {
  it('answers 500 for an unknown mode without reading the secret', async () => {
    stubFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env: testEnv, reads } = makeEnv({ BACKEND_CREDENTIAL_ACCEPT: 'legacy-or-sts' });
    const response = await call(app, 'dispatch', testEnv, { Authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'server_misconfigured' });
    expect(reads()).toBe(0);
  });

  it('refuses both credentials when disabled', async () => {
    const fetches = stubFetch();
    const { env: testEnv, reads } = makeEnv({
      BACKEND_CREDENTIAL_ACCEPT: 'disabled',
      STS_ENVIRONMENT: 'production',
    });
    const legacy = await call(app, 'dispatch', testEnv, { Authorization: `Bearer ${SECRET}` });
    const sts = await call(app, 'dispatch', testEnv, { Authorization: `Bearer ${await token()}` });
    expect([legacy.status, sts.status]).toEqual([401, 401]);
    expect(reads()).toBe(0);
    expect(fetches).toEqual([]);
  });
});

describe.each(['legacy-and-sts', 'sts-only'])('mode %s', mode => {
  const vars = { BACKEND_CREDENTIAL_ACCEPT: mode, STS_ENVIRONMENT: 'production' };

  it.each(ROUTE_NAMES)(
    'admits a web token for %s and logs the sts admission with the verified caller',
    async route => {
      const fetches = stubFetch();
      const log = vi.spyOn(console, 'log');
      const { env: testEnv, reads } = makeEnv(vars);
      const bearer = await token(route);
      // The unsigned caller header names someone else; the line names the verified workload.
      const response = await call(app, route, testEnv, {
        Authorization: `Bearer ${bearer}`,
        'x-kilo-caller': 'ai-gateway',
      });
      expect(response.status).toBe(REQUESTS[route].admitted);
      expect(reads()).toBe(mode === 'legacy-and-sts' ? 1 : 0);
      expect(fetches.every(url => url === JWKS_URL)).toBe(true);
      const lines = authLines(log);
      expect(lines).toEqual([
        {
          event: 'kilo_internal_auth',
          v: 1,
          receiver: 'code-review-infra',
          route: REVIEW_ROUTES[route].label,
          auth: 'sts',
          caller: 'web',
          count: 1,
          minute: expect.any(Number),
        },
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(bearer);
    }
  );

  it.each<[string, () => Promise<string>, ReviewRouteName, number, string]>([
    ['the scope of another route', () => token('statusRead'), 'cancel', 403, 'insufficient_scope'],
    [
      'another audience',
      () => token('dispatch', { aud: 'web', scope: 'web:sts.canary' }),
      'dispatch',
      403,
      'insufficient_scope',
    ],
    [
      'a scope not registered for code-review',
      () => token('dispatch', { scope: 'code-review:everything' }),
      'dispatch',
      403,
      'insufficient_scope',
    ],
    [
      'a workload other than web',
      () => token('dispatch', {}, 'ai-gateway'),
      'dispatch',
      403,
      'insufficient_scope',
    ],
    [
      'another environment',
      () => token('dispatch', { env: 'staging' }),
      'dispatch',
      401,
      'invalid_token',
    ],
    [
      'another issuer',
      () => token('dispatch', { iss: STS_ISSUERS.staging }),
      'dispatch',
      401,
      'invalid_token',
    ],
    [
      'an expired token',
      () => {
        const past = Math.floor(Date.now() / 1000) - 3_600;
        return token('dispatch', { iat: past, exp: past + 300 });
      },
      'dispatch',
      401,
      'invalid_token',
    ],
    [
      'a forged signature',
      async () => token('dispatch', {}, 'web', await testSigner(signer.kid)),
      'dispatch',
      401,
      'invalid_token',
    ],
    ['a malformed token', async () => 'not.a.token', 'dispatch', 401, 'invalid_token'],
  ])(
    'refuses %s and never retries it as the shared secret',
    async (_label, make, route, status, error) => {
      stubFetch();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log');
      const { env: testEnv } = makeEnv(vars);
      const bearer = await make();
      const response = await call(app, route, testEnv, { Authorization: `Bearer ${bearer}` });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(authLines(log)).toEqual([]);
      const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
      expect(logged).toContain('code_review_backend_sts_refused');
      expect(logged).not.toContain(bearer);
      expect(logged).not.toContain(SECRET);
    }
  );

  it('refuses a request whose Authorization carries both credentials', async () => {
    stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: testEnv } = makeEnv(vars);
    const headers = new Headers();
    headers.append('Authorization', `Bearer ${SECRET}`);
    headers.append('Authorization', `Bearer ${await token()}`);
    const response = await call(app, 'dispatch', testEnv, headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_token' });
  });

  it('answers 500 when STS_ENVIRONMENT is missing or has no deployment', async () => {
    stubFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const environment of [undefined, 'prod', 'staging']) {
      const { env: testEnv } = makeEnv({
        BACKEND_CREDENTIAL_ACCEPT: mode,
        STS_ENVIRONMENT: environment,
      });
      const response = await call(app, 'dispatch', testEnv, {
        Authorization: `Bearer ${await token()}`,
      });
      expect(response.status).toBe(500);
    }
  });

  it('keeps the shared secret on /health', async () => {
    stubFetch();
    const { env: testEnv } = makeEnv(vars);
    const legacy = await app.request(
      '/health',
      { headers: { Authorization: `Bearer ${SECRET}` } },
      testEnv
    );
    const sts = await app.request(
      '/health',
      { headers: { Authorization: `Bearer ${await token()}` } },
      testEnv
    );
    expect([legacy.status, sts.status]).toEqual([200, 401]);
  });

  it('serves the metadata the challenge names, from configuration only', async () => {
    const fetches = stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: testEnv, reads } = makeEnv(vars);
    const metadata = await app.request(
      'https://attacker.example/.well-known/oauth-protected-resource',
      {},
      testEnv
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      resource: ORIGIN,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ROUTE_NAMES.map(name => REVIEW_ROUTES[name].scope),
    });
    expect(reads()).toBe(0);
    expect(fetches).toEqual([]);
    const challenge = await call(app, 'dispatch', testEnv, {});
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      `resource_metadata="${METADATA_URL}"`
    );
  });
});

describe('legacy-and-sts', () => {
  const vars = { BACKEND_CREDENTIAL_ACCEPT: 'legacy-and-sts', STS_ENVIRONMENT: 'production' };

  it.each(ROUTE_NAMES)('admits the shared secret on %s with no key-set fetch', async route => {
    const fetches = stubFetch();
    const log = vi.spyOn(console, 'log');
    const { env: testEnv } = makeEnv(vars);
    const response = await call(app, route, testEnv, { Authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(REQUESTS[route].admitted);
    expect(fetches).toEqual([]);
    expect(authLines(log)).toEqual([
      expect.objectContaining({
        route: REVIEW_ROUTES[route].label,
        auth: 'legacy_shared_secret',
      }),
    ]);
  });
});

describe('sts-only', () => {
  it('refuses the shared secret without reading it', async () => {
    stubFetch();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: testEnv, reads } = makeEnv({
      BACKEND_CREDENTIAL_ACCEPT: 'sts-only',
      STS_ENVIRONMENT: 'production',
    });
    const response = await call(app, 'dispatch', testEnv, { Authorization: `Bearer ${SECRET}` });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_token' });
    expect(reads()).toBe(0);
  });
});

describe('a fresh guard', () => {
  /** The guard alone on the dispatch route, so no key set carries over from other tests. */
  function guarded() {
    const hono = new Hono<{ Bindings: Env }>();
    hono.use(
      '*',
      createBackendAuth<{ Bindings: Env }>(() => SECRET)
    );
    hono.post(REVIEW_ROUTES.dispatch.path, c => c.body(null, 202));
    return hono;
  }

  it('answers 503 with Retry-After while the STS key set is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 502 }))
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: testEnv } = makeEnv({
      BACKEND_CREDENTIAL_ACCEPT: 'sts-only',
      STS_ENVIRONMENT: 'production',
    });
    const response = await call(guarded(), 'dispatch', testEnv, {
      Authorization: `Bearer ${await token()}`,
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
  });

  it('fetches only the production issuer key set, once', async () => {
    const fetches = stubFetch();
    const { env: testEnv } = makeEnv({
      BACKEND_CREDENTIAL_ACCEPT: 'sts-only',
      STS_ENVIRONMENT: 'production',
    });
    const hono = guarded();
    for (let i = 0; i < 3; i++) {
      const response = await call(hono, 'dispatch', testEnv, {
        Authorization: `Bearer ${await token()}`,
      });
      expect(response.status).toBe(202);
    }
    expect(fetches).toEqual([JWKS_URL]);
  });
});
