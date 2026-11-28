import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey as JoseKey } from 'jose';
import { JWKS_PATH, STS_ISSUERS, STS_USAGE_RECORD } from '@kilocode/sts-contracts';
import { ENKRYPT_USAGE_WRITE_PATH, EXA_USAGE_WRITE_PATH } from '@kilocode/usage-contracts';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { resetInternalAuthObservation } from '@kilocode/worker-utils/internal-auth-observation';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { timingSafeEqual } from '@kilocode/encryption';
import type * as StsContracts from '@kilocode/sts-contracts';
import type * as SharedAuth from './internal-api-auth';
import type * as UsageRecordAuth from './usage-record-auth';
import { dispatchSecurityLifecyclePush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { POST as recordUsage } from '@/app/api/internal/usage/record/route';
import { POST as recordEnkryptUsage } from '@/app/api/internal/enkrypt-usage/record/route';
import { POST as recordExaUsage } from '@/app/api/internal/exa-usage/record/route';
import { POST as securityNotification } from '@/app/api/internal/security-agent/notifications/route';
import {
  authorizeInternalApiRequest,
  authorizeInternalServiceRequest,
  type InternalServiceEdge,
} from './internal-api-auth';

// The shared web receiver against a real verifier. Only the STS key-set fetch is stubbed. The
// registry carries the web scopes `igor/sts-c1-registry` registers, as it will once that lands;
// `usage-record-auth.test.ts` keeps the current registry and shows they are refused until then.

jest.mock('@kilocode/sts-contracts', () => {
  const actual = jest.requireActual<typeof StsContracts>('@kilocode/sts-contracts');
  return {
    ...actual,
    STS_SCOPE_REGISTRY: {
      ...actual.STS_SCOPE_REGISTRY,
      web: {
        scopes: [
          ...(actual.STS_SCOPE_REGISTRY.web?.scopes ?? []),
          'web:auto-routing.pool-pins.write',
          'web:auto-routing.production-profile.read',
          'web:usage.receipts.read',
          'web:usage.classifier.record',
          'web:usage.benchmark-grader.record',
          'web:usage.region-handoff.record',
          'web:claude-billing.payer-state.read',
          'web:byoc-credentials.read',
          'web:byoc-credentials.write',
          'web:hosted-workspace-pull-requests.refresh',
          'web:glanceable-snapshot.read',
          'web:bot-session.callback',
          'web:security-analysis.callback',
          'web:code-review.agent-callback',
          'web:code-review.status-callback',
          'web:compute-balance-alert.send',
          'web:scim.sync',
          'web:user-data-exports.ready',
          'web:security-notifications.lifecycle',
        ],
      },
    },
  };
});

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/config.server'),
  // STS_ISSUERS.development: outside Vercel this process's STS environment is development.
  STS_URL: 'http://localhost:8825',
}));

jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  dispatchSecurityFindingPush: jest.fn(),
  dispatchSecurityLifecyclePush: jest.fn(),
  dispatchLowBalancePush: jest.fn(),
}));

jest.mock('next/server', () => ({
  ...jest.requireActual<Record<string, unknown>>('next/server'),
  after: (fn: () => unknown) => void fn(),
}));

const KID = 'internal-service-test';
const ORIGIN = new URL(APP_URL).origin;
const CHALLENGE = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`;
const JWKS_URL = `${STS_ISSUERS.development}${JWKS_PATH}`;
const SWITCHES = [
  'AUTO_ROUTING_POOL_PINS_RECEIVER_AUTH',
  'AUTO_ROUTING_PRODUCTION_PROFILE_RECEIVER_AUTH',
  'BYOC_CREDENTIALS_RECEIVER_AUTH',
  'SCIM_SYNC_RECEIVER_AUTH',
  'SECURITY_NOTIFICATIONS_RECEIVER_AUTH',
  'USAGE_RECORD_AUTH',
  'VERCEL_ENV',
  'VERCEL_TARGET_ENV',
] as const;
const savedEnv = Object.fromEntries(SWITCHES.map(name => [name, process.env[name]]));
const nativeFetch = globalThis.fetch;

let signingKey: JoseKey;
let otherKey: JoseKey;
let jwks: { keys: unknown[] };
const keySetFetches: string[] = [];
let keySetUp = true;
let observed: jest.SpiedFunction<typeof console.log>;

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair('EdDSA', { crv: 'Ed25519' })).privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'EdDSA' }] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== JWKS_URL) return nativeFetch(input, init);
    keySetFetches.push(url);
    return keySetUp ? Response.json(jwks) : new Response(null, { status: 503 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = nativeFetch;
  for (const name of SWITCHES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

beforeEach(() => {
  for (const name of SWITCHES) delete process.env[name];
  delete process.env.INTERNAL_AUTH_OBSERVATION_ENABLED;
  resetInternalAuthObservation();
  observed = jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

type TokenOptions = {
  workload: string;
  scope: string;
  audience?: string;
  env?: string;
  issuer?: string;
  issuedAt?: number;
  key?: JoseKey;
};

async function token(options: TokenOptions): Promise<string> {
  const iat = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return await new SignJWT({
    client_id: options.workload,
    req: options.workload,
    env: options.env ?? 'development',
    scope: options.scope,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: KID })
    .setIssuer(options.issuer ?? STS_ISSUERS.development)
    .setSubject(`service:${options.workload}`)
    .setAudience(options.audience ?? 'web')
    .setJti(crypto.randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(options.key ?? signingKey);
}

async function bearer(options: TokenOptions): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await token(options)}` };
}

const SCIM = { workload: 'cloudflare-scim-sync', scope: 'web:scim.sync' };
const secret = { 'x-internal-api-key': INTERNAL_API_SECRET };

/** Runs the shared receiver with the standard secret check as the legacy check, counting calls. */
async function authorize(
  edge: InternalServiceEdge,
  headers: Record<string, string>,
  route = 'test_route'
) {
  const request = new Request(`${ORIGIN}/api/internal/test`, { method: 'POST', headers });
  let legacyCalls = 0;
  const result = await authorizeInternalServiceRequest(request, edge, route, () => {
    legacyCalls += 1;
    return authorizeInternalApiRequest(request, route);
  });
  return { result, legacyCalls };
}

async function expectRefused(
  outcome: { result: unknown; legacyCalls: number },
  status: number,
  body?: Record<string, unknown>
) {
  expect(outcome.result).toBeInstanceOf(Response);
  const response = outcome.result as Response;
  expect(response.status).toBe(status);
  if (body !== undefined) expect((await response.json()) as unknown).toMatchObject(body);
  return response;
}

function observations(): Record<string, unknown>[] {
  return observed.mock.calls.map(call => JSON.parse(String(call[0])) as Record<string, unknown>);
}

// Declared first: no test before these has fetched the key set.
describe('a switch absent, empty or legacy', () => {
  it.each([[undefined], [''], ['legacy']])('runs only the legacy check (%p)', async mode => {
    if (mode !== undefined) process.env.SCIM_SYNC_RECEIVER_AUTH = mode;
    const accepted = await authorize('scim_sync', secret);
    expect(accepted.result).toEqual({ credential: 'legacy' });
    expect(accepted.legacyCalls).toBe(1);
    // A valid STS token is no credential here; nothing verifies it.
    const withToken = await authorize('scim_sync', await bearer(SCIM));
    await expectRefused(withToken, 401, { error: 'Unauthorized' });
    expect(withToken.legacyCalls).toBe(1);
    expect(keySetFetches).toEqual([]);
  });
});

describe('an unknown switch value', () => {
  it.each([['STS'], ['sts-only'], ['bogus']])(
    'refuses every request with 503 (%s)',
    async value => {
      process.env.SCIM_SYNC_RECEIVER_AUTH = value;
      for (const headers of [secret, await bearer(SCIM), {}]) {
        const outcome = await authorize('scim_sync', headers);
        await expectRefused(outcome, 503, { error: 'Service unavailable' });
        expect(outcome.legacyCalls).toBe(0);
      }
    }
  );
});

describe('dual', () => {
  beforeEach(() => {
    process.env.SCIM_SYNC_RECEIVER_AUTH = 'dual';
  });

  it('admits the granted workload with its scope and records a fixed sts line', async () => {
    const outcome = await authorize('scim_sync', await bearer(SCIM), 'scim_user');
    expect(outcome.result).toEqual({ credential: 'sts', scope: 'web:scim.sync' });
    expect(outcome.legacyCalls).toBe(0);
    expect(observations()).toEqual([
      expect.objectContaining({ route: 'scim_user', auth: 'sts', caller: 'scim-sync' }),
    ]);
  });

  it('keeps the legacy check for a secret, both header spellings, and for no credential', async () => {
    const apiKey = await authorize('scim_sync', secret);
    expect(apiKey.result).toEqual({ credential: 'legacy' });
    const internalSecret = await authorize('scim_sync', {
      'x-internal-secret': INTERNAL_API_SECRET,
    });
    expect(internalSecret.result).toEqual({ credential: 'legacy' });
    const wrong = await authorize('scim_sync', { 'x-internal-api-key': 'wrong' });
    await expectRefused(wrong, 401, { error: 'Unauthorized' });
    const none = await authorize('scim_sync', {});
    await expectRefused(none, 401, { error: 'Unauthorized' });
    expect([apiKey, internalSecret, wrong, none].map(o => o.legacyCalls)).toEqual([1, 1, 1, 1]);
  });

  it.each([
    ['another workload', { ...SCIM, workload: 'user-data-export' }, 403, 'insufficient_scope'],
    [
      'another web scope',
      { ...SCIM, scope: 'web:user-data-exports.ready' },
      403,
      'insufficient_scope',
    ],
    ['an unregistered scope', { ...SCIM, scope: 'web:not-registered' }, 403, 'insufficient_scope'],
    [
      'another audience',
      { ...SCIM, audience: 'o11y', scope: 'o11y:alerting.read' },
      403,
      'insufficient_scope',
    ],
    ['another environment', { ...SCIM, env: 'production' }, 401, 'invalid_token'],
    ['another issuer', { ...SCIM, issuer: STS_ISSUERS.staging }, 401, 'invalid_token'],
    [
      'an expired token',
      { ...SCIM, issuedAt: Math.floor(Date.now() / 1000) - 1_000 },
      401,
      'invalid_token',
    ],
  ])('refuses %s with no fallback to the secret', async (_name, options, status, error) => {
    const outcome = await authorize('scim_sync', await bearer(options));
    const response = await expectRefused(outcome, status, { error });
    expect(response.headers.get('www-authenticate')).toContain(CHALLENGE);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(outcome.legacyCalls).toBe(0);
    expect(observations()).toEqual([]);
  });

  it('refuses a forged or malformed bearer with 401 and no fallback', async () => {
    const forged = await authorize('scim_sync', await bearer({ ...SCIM, key: otherKey }));
    await expectRefused(forged, 401, { error: 'invalid_token' });
    const malformed = await authorize('scim_sync', { authorization: 'Bearer not-a-token' });
    await expectRefused(malformed, 401);
    expect(forged.legacyCalls + malformed.legacyCalls).toBe(0);
  });

  it.each([
    ['x-internal-api-key'],
    ['x-internal-secret'],
    ['x-callback-token'],
    ['x-bot-callback-token'],
  ])('refuses an STS bearer beside %s with 400, valid or not', async header => {
    for (const authorization of [await bearer(SCIM), { authorization: 'Bearer not-a-token' }]) {
      const outcome = await authorize('scim_sync', {
        ...authorization,
        [header]: INTERNAL_API_SECRET,
      });
      await expectRefused(outcome, 400, { error: 'invalid_request' });
      expect(outcome.legacyCalls).toBe(0);
    }
  });

  it('without an STS deployment answers tokens 503 and keeps the secret', async () => {
    // Production labels select the production issuer, which is not this process's STS_URL.
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
    await expectRefused(await authorize('scim_sync', await bearer(SCIM)), 503, {
      error: 'Service unavailable',
    });
    expect((await authorize('scim_sync', secret)).result).toEqual({ credential: 'legacy' });
  });
});

describe('sts', () => {
  beforeEach(() => {
    process.env.SCIM_SYNC_RECEIVER_AUTH = 'sts';
  });

  it('admits the granted token', async () => {
    expect((await authorize('scim_sync', await bearer(SCIM))).result).toEqual({
      credential: 'sts',
      scope: 'web:scim.sync',
    });
  });

  it.each([
    ['the correct secret', secret],
    ['x-internal-secret', { 'x-internal-secret': INTERNAL_API_SECRET }],
    ['no credential', {}],
  ])(
    'refuses %s with 401 and the challenge, never running the legacy check',
    async (_n, headers) => {
      const outcome = await authorize('scim_sync', headers);
      const response = await expectRefused(outcome, 401, { error: 'Unauthorized' });
      expect(response.headers.get('www-authenticate')).toBe(`Bearer ${CHALLENGE}`);
      expect(outcome.legacyCalls).toBe(0);
    }
  );

  it('without an STS deployment refuses everything with 503', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
    for (const headers of [await bearer(SCIM), secret, {}]) {
      const outcome = await authorize('scim_sync', headers);
      await expectRefused(outcome, 503);
      expect(outcome.legacyCalls).toBe(0);
    }
  });
});

describe('the legacy secret as a bearer (production profile)', () => {
  const PROFILE = {
    workload: 'auto-routing-benchmark',
    scope: 'web:auto-routing.production-profile.read',
  };
  const OPAQUE = 'opaque-legacy-secret';

  /**
   * The route's legacy check, as `production-profile/route.ts` runs it: the bearer compared with
   * the configured secret. `secret` stands in for that configured value.
   */
  async function profile(headers: Record<string, string>, secret: string | Error) {
    const request = new Request(
      `${ORIGIN}/api/internal/auto-routing-benchmark/production-profile`,
      {
        headers,
      }
    );
    let legacyCalls = 0;
    const result = await authorizeInternalServiceRequest(
      request,
      'auto_routing_production_profile',
      'auto_routing_benchmark_production_profile',
      async () => {
        legacyCalls += 1;
        if (secret instanceof Error) throw secret;
        const presented = extractBearerToken(request.headers.get('authorization'));
        return presented !== null && timingSafeEqual(presented, secret)
          ? null
          : Response.json({ error: 'Unauthorized' }, { status: 401 });
      }
    );
    return { result, legacyCalls };
  }

  let jwsSecret: string;

  beforeEach(async () => {
    // A configured secret that is itself a compact JWS, even a signed one: only an exact match may
    // make it legacy, never its shape.
    jwsSecret = await token({ ...PROFILE, key: otherKey });
  });

  describe('under dual', () => {
    beforeEach(() => {
      process.env.AUTO_ROUTING_PRODUCTION_PROFILE_RECEIVER_AUTH = 'dual';
    });

    it('admits the exact legacy secret, opaque or JWS-shaped, as legacy', async () => {
      for (const secret of [OPAQUE, jwsSecret]) {
        const outcome = await profile({ authorization: `Bearer ${secret}` }, secret);
        expect(outcome.result).toEqual({ credential: 'legacy' });
        expect(outcome.legacyCalls).toBe(1);
      }
    });

    it('admits a valid STS token after the legacy check refuses it', async () => {
      const outcome = await profile(await bearer(PROFILE), jwsSecret);
      expect(outcome.result).toEqual({ credential: 'sts', scope: PROFILE.scope });
      expect(outcome.legacyCalls).toBe(1);
    });

    it('refuses a forged token, a wrong secret and a malformed bearer at STS, finally', async () => {
      for (const headers of [
        await bearer({ ...PROFILE, key: otherKey }),
        { authorization: `Bearer ${OPAQUE}-wrong` },
        { authorization: 'Bearer not-a-token' },
      ]) {
        const outcome = await profile(headers, jwsSecret);
        const response = await expectRefused(outcome, 401, { error: 'invalid_token' });
        expect(response.headers.get('www-authenticate')).toContain(CHALLENGE);
        expect(outcome.legacyCalls).toBe(1);
      }
    });

    it('refuses a bearer beside another legacy credential header with 400', async () => {
      const outcome = await profile(
        { authorization: `Bearer ${jwsSecret}`, 'x-internal-api-key': OPAQUE },
        jwsSecret
      );
      await expectRefused(outcome, 400, { error: 'invalid_request' });
      expect(outcome.legacyCalls).toBe(0);
    });

    it('depends on the legacy secret read for every bearer', async () => {
      await expect(profile(await bearer(PROFILE), new Error('secret unavailable'))).rejects.toThrow(
        'secret unavailable'
      );
    });
  });

  describe('under sts', () => {
    beforeEach(() => {
      process.env.AUTO_ROUTING_PRODUCTION_PROFILE_RECEIVER_AUTH = 'sts';
    });

    it('never reads the legacy secret: a valid token passes even when the read would fail', async () => {
      const outcome = await profile(await bearer(PROFILE), new Error('secret unavailable'));
      expect(outcome.result).toEqual({ credential: 'sts', scope: PROFILE.scope });
      expect(outcome.legacyCalls).toBe(0);
    });

    it('refuses the exact legacy secret, opaque or JWS-shaped, at STS', async () => {
      for (const secret of [OPAQUE, jwsSecret]) {
        const outcome = await profile({ authorization: `Bearer ${secret}` }, secret);
        await expectRefused(outcome, 401, { error: 'invalid_token' });
        expect(outcome.legacyCalls).toBe(0);
      }
    });

    it('refuses no credential with 401 and the challenge', async () => {
      const outcome = await profile({}, jwsSecret);
      const response = await expectRefused(outcome, 401, { error: 'Unauthorized' });
      expect(response.headers.get('www-authenticate')).toBe(`Bearer ${CHALLENGE}`);
      expect(outcome.legacyCalls).toBe(0);
    });
  });
});

describe('per-edge scopes and workloads', () => {
  it('keeps BYOC reads and writes apart', async () => {
    process.env.BYOC_CREDENTIALS_RECEIVER_AUTH = 'dual';
    const read = { workload: 'cloud-agent-next', scope: 'web:byoc-credentials.read' };
    expect((await authorize('byoc_credentials_read', await bearer(read))).result).toEqual({
      credential: 'sts',
      scope: read.scope,
    });
    await expectRefused(await authorize('byoc_credentials_write', await bearer(read)), 403);
  });

  it('admits each security notification sender with its own scope only', async () => {
    process.env.SECURITY_NOTIFICATIONS_RECEIVER_AUTH = 'dual';
    const dispatch = {
      workload: 'cloudflare-security-sync',
      scope: 'web:security-notifications.dispatch',
    };
    const lifecycle = {
      workload: 'security-auto-analysis',
      scope: 'web:security-notifications.lifecycle',
    };
    expect((await authorize('security_notifications', await bearer(dispatch))).result).toEqual({
      credential: 'sts',
      scope: dispatch.scope,
    });
    expect((await authorize('security_notifications', await bearer(lifecycle))).result).toEqual({
      credential: 'sts',
      scope: lifecycle.scope,
    });
    await expectRefused(
      await authorize(
        'security_notifications',
        await bearer({ ...dispatch, workload: lifecycle.workload })
      ),
      403
    );
  });
});

describe('an unreachable STS key set', () => {
  it('answers STS tokens 503 with Retry-After and never runs the legacy check', async () => {
    process.env.SCIM_SYNC_RECEIVER_AUTH = 'dual';
    keySetUp = false;
    try {
      let load: typeof authorizeInternalServiceRequest | undefined;
      // A fresh module instance: its verifier holds no key set yet.
      await jest.isolateModulesAsync(async () => {
        load = (await import('./internal-api-auth')).authorizeInternalServiceRequest;
      });
      if (load === undefined) throw new Error('module did not load');
      const request = new Request(`${ORIGIN}/api/internal/test`, {
        method: 'POST',
        headers: await bearer(SCIM),
      });
      let legacyCalls = 0;
      const refused = await load(request, 'scim_sync', 'scim_user', async () => {
        legacyCalls += 1;
        return null;
      });
      expect(refused).toBeInstanceOf(Response);
      const response = refused as Response;
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).not.toBeNull();
      expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(legacyCalls).toBe(0);
    } finally {
      keySetUp = true;
    }
  });
});

describe('one verifier for every edge', () => {
  it('fetches the STS key set once across edges and the usage record routes', async () => {
    process.env.SCIM_SYNC_RECEIVER_AUTH = 'dual';
    process.env.BYOC_CREDENTIALS_RECEIVER_AUTH = 'dual';
    process.env.USAGE_RECORD_AUTH = 'dual';
    let shared: typeof SharedAuth | undefined;
    let usage: typeof UsageRecordAuth | undefined;
    await jest.isolateModulesAsync(async () => {
      shared = await import('./internal-api-auth');
      usage = await import('./usage-record-auth');
    });
    if (shared === undefined || usage === undefined) throw new Error('modules did not load');
    const before = keySetFetches.length;
    const request = async (options: TokenOptions, extra: Record<string, string> = {}) =>
      new Request(`${ORIGIN}/api/internal/test`, {
        method: 'POST',
        headers: { ...(await bearer(options)), ...extra },
      });
    const results = await Promise.all([
      shared.authorizeInternalServiceRequest(
        await request(SCIM),
        'scim_sync',
        'scim_user',
        async () => null
      ),
      shared.authorizeInternalServiceRequest(
        await request({ workload: 'cloud-agent-next', scope: 'web:byoc-credentials.read' }),
        'byoc_credentials_read',
        'byoc_connections',
        async () => null
      ),
      usage.authorizeUsageRecordRequest(
        await request(
          { workload: 'usage-ingest', scope: STS_USAGE_RECORD.scope },
          { 'x-usage-write-source': 'queue' }
        ),
        '/api/internal/usage/record'
      ),
    ]);
    expect(results.map(result => (result instanceof Response ? result.status : result))).toEqual([
      { credential: 'sts', scope: 'web:scim.sync' },
      { credential: 'sts', scope: 'web:byoc-credentials.read' },
      null,
    ]);
    expect(keySetFetches.length - before).toBe(1);
  });
});

describe('the usage record writers (USAGE_RECORD_AUTH=dual)', () => {
  type Post = (request: NextRequest) => Promise<Response>;

  async function send(post: Post, path: string, headers: Record<string, string>) {
    const request = new NextRequest(`${ORIGIN}${path}`, {
      method: 'POST',
      headers,
      body: 'not json',
    });
    const response = await post(request);
    return {
      status: response.status,
      body: (await response.json()) as unknown,
      read: request.bodyUsed,
    };
  }

  const admitted = { status: 400, body: { error: 'Invalid body' }, read: true };
  const CLASSIFIER = { workload: 'auto-routing', scope: 'web:usage.classifier.record' };
  const GRADER = { workload: 'auto-routing-benchmark', scope: 'web:usage.benchmark-grader.record' };
  const HANDOFF = { workload: 'ai-gateway', scope: 'web:usage.region-handoff.record' };
  const QUEUE = { workload: 'usage-ingest', scope: STS_USAGE_RECORD.scope };
  const record = '/api/internal/usage/record';

  beforeEach(() => {
    process.env.USAGE_RECORD_AUTH = 'dual';
  });

  it('admits each writer only with its own source', async () => {
    expect(await send(recordUsage, record, await bearer(CLASSIFIER))).toEqual(admitted);
    expect(await send(recordUsage, record, await bearer(GRADER))).toEqual(admitted);
    expect(
      await send(recordUsage, record, {
        ...(await bearer(HANDOFF)),
        'x-usage-write-source': 'region_handoff',
      })
    ).toEqual(admitted);
    expect(await send(recordEnkryptUsage, ENKRYPT_USAGE_WRITE_PATH, await bearer(HANDOFF))).toEqual(
      admitted
    );
    expect(
      await send(recordUsage, record, { ...(await bearer(QUEUE)), 'x-usage-write-source': 'queue' })
    ).toEqual(admitted);
  });

  it.each([
    ['the classifier claiming the queue', recordUsage, record, CLASSIFIER, 'queue'],
    ['the grader claiming a region handoff', recordUsage, record, GRADER, 'region_handoff'],
    ['a region handoff without its source', recordUsage, record, HANDOFF, null],
    ['a region handoff claiming the queue', recordUsage, record, HANDOFF, 'queue'],
    ['the queue without its source', recordUsage, record, QUEUE, null],
    ['a region handoff on Exa', recordExaUsage, EXA_USAGE_WRITE_PATH, HANDOFF, null],
    ['the classifier on Enkrypt', recordEnkryptUsage, ENKRYPT_USAGE_WRITE_PATH, CLASSIFIER, null],
    [
      'the classifier scope from the gateway',
      recordUsage,
      record,
      { ...CLASSIFIER, workload: 'ai-gateway' },
      null,
    ],
  ] as const)('refuses %s with 403 before the body', async (_name, post, path, options, source) => {
    const headers = await bearer(options);
    if (source !== null) headers['x-usage-write-source'] = source;
    const result = await send(post, path, headers);
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: 'insufficient_scope' });
    expect(result.read).toBe(false);
  });
});

describe('security notifications bind each scope to its body', () => {
  const lifecycleBody = {
    event: 'analysis_completed',
    findingId: crypto.randomUUID(),
    scope: 'personal',
    recipientUserIds: ['user-1'],
  };

  async function post(scope: TokenOptions, body: unknown) {
    const request = new NextRequest(`${ORIGIN}/api/internal/security-agent/notifications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await bearer(scope)) },
      body: JSON.stringify(body),
    });
    return securityNotification(request);
  }

  const DISPATCH = {
    workload: 'cloudflare-security-sync',
    scope: 'web:security-notifications.dispatch',
  };
  const LIFECYCLE = {
    workload: 'security-auto-analysis',
    scope: 'web:security-notifications.lifecycle',
  };

  beforeEach(() => {
    process.env.SECURITY_NOTIFICATIONS_RECEIVER_AUTH = 'dual';
  });

  it('admits a lifecycle event under the lifecycle scope', async () => {
    const response = await post(LIFECYCLE, lifecycleBody);
    expect(response.status).toBe(200);
    expect(jest.mocked(dispatchSecurityLifecyclePush)).toHaveBeenCalledTimes(1);
  });

  it('refuses a lifecycle event under the dispatch scope and a dispatch under the lifecycle scope', async () => {
    jest.mocked(dispatchSecurityLifecyclePush).mockClear();
    const lifecycleAsDispatch = await post(DISPATCH, lifecycleBody);
    expect(lifecycleAsDispatch.status).toBe(403);
    expect(await lifecycleAsDispatch.json()).toEqual({
      error: 'insufficient_scope',
      scope: LIFECYCLE.scope,
    });
    const dispatchAsLifecycle = await post(LIFECYCLE, { notificationId: crypto.randomUUID() });
    expect(dispatchAsLifecycle.status).toBe(403);
    expect(await dispatchAsLifecycle.json()).toEqual({
      error: 'insufficient_scope',
      scope: DISPATCH.scope,
    });
    expect(jest.mocked(dispatchSecurityLifecyclePush)).not.toHaveBeenCalled();
  });
});
