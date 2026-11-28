import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey as JoseKey } from 'jose';
import {
  JWKS_PATH,
  STS_ISSUERS,
  STS_USAGE_PUBLISH,
  STS_USAGE_RECORD,
} from '@kilocode/sts-contracts';
import { ENKRYPT_USAGE_WRITE_PATH, EXA_USAGE_WRITE_PATH } from '@kilocode/usage-contracts';
import { INTERNAL_API_SECRET, STS_URL } from '@kilocode/web-shared/lib/config.server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import {
  queueWriterAdmission,
  taggedWriterAdmission,
} from '@kilocode/web-shared/lib/ai-gateway/usage-writer-admission';
import { POST as recordUsage } from '@/app/api/internal/usage/record/route';
import { POST as recordEnkryptUsage } from '@/app/api/internal/enkrypt-usage/record/route';
import { POST as recordExaUsage } from '@/app/api/internal/exa-usage/record/route';
import { GET as resourceMetadata } from '@/app/.well-known/oauth-protected-resource/api/internal/[product]/record/route';
import type { authorizeInternalApiRequest as AuthorizeInternalApiRequest } from '@/lib/internal-api-auth';
import type { authorizeUsageRecordRequest as AuthorizeUsageRecordRequest } from './usage-record-auth';

// The three record routes and the metadata route against a real verifier. Only the STS key-set
// fetch is stubbed; every body is malformed JSON, so an admitted request stops at the route's own
// 400 before admission or any database work, and a refused one never reads the body.

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/config.server'),
  // STS_ISSUERS.development: outside Vercel this process's STS environment is development.
  STS_URL: 'http://localhost:8825',
}));

// Counts every internal API secret check, so `sts` can show it never compares the secret.
const mockSecretChecks: Request[] = [];
jest.mock('@/lib/internal-api-auth', () => {
  const actual = jest.requireActual<{
    authorizeInternalApiRequest: typeof AuthorizeInternalApiRequest;
  }>('@/lib/internal-api-auth');
  return {
    authorizeInternalApiRequest: (request: Request) => {
      mockSecretChecks.push(request);
      return actual.authorizeInternalApiRequest(request, 'usage_record');
    },
  };
});

const KID = 'usage-record-test';
const ORIGIN = new URL(APP_URL).origin;
const JWKS_URL = `${STS_ISSUERS.development}${JWKS_PATH}`;
const ENV_NAMES = [
  'USAGE_RECORD_AUTH',
  'VERCEL_ENV',
  'VERCEL_TARGET_ENV',
  'PORT',
  'APP_URL_OVERRIDE',
] as const;
const savedEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
const nativeFetch = globalThis.fetch;

let signingKey: JoseKey;
let otherKey: JoseKey;
let jwks: { keys: unknown[] };
const keySetFetches: string[] = [];
let keySetUp = true;

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
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

let queueAcquire: jest.SpiedFunction<typeof queueWriterAdmission.acquire>;
let taggedAcquire: jest.SpiedFunction<typeof taggedWriterAdmission.acquire>;

beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  mockSecretChecks.length = 0;
  queueAcquire = jest.spyOn(queueWriterAdmission, 'acquire');
  taggedAcquire = jest.spyOn(taggedWriterAdmission, 'acquire');
});

afterEach(() => {
  jest.restoreAllMocks();
});

type TokenOptions = {
  workload?: string;
  audience?: string;
  scope?: string;
  env?: string;
  issuer?: string;
  issuedAt?: number;
  key?: JoseKey;
};

async function stsToken(options: TokenOptions = {}): Promise<string> {
  const workload = options.workload ?? 'usage-ingest';
  const iat = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return await new SignJWT({
    client_id: workload,
    req: workload,
    env: options.env ?? 'development',
    scope: options.scope ?? STS_USAGE_RECORD.scope,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: KID })
    .setIssuer(options.issuer ?? STS_ISSUERS.development)
    .setSubject(`service:${workload}`)
    .setAudience(options.audience ?? STS_USAGE_RECORD.audience)
    .setJti(crypto.randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(options.key ?? signingKey);
}

async function bearer(options?: TokenOptions): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await stsToken(options)}` };
}

const secret = { 'x-internal-api-key': INTERNAL_API_SECRET };
const queue = { 'x-usage-write-source': 'queue' };

const ROUTES = [
  ['/api/internal/usage/record', recordUsage],
  [ENKRYPT_USAGE_WRITE_PATH, recordEnkryptUsage],
  [EXA_USAGE_WRITE_PATH, recordExaUsage],
] as const;

type Post = (request: NextRequest) => Promise<Response>;
type Sent = { response: Response; bodyRead: boolean };

async function send(path: string, post: Post, headers: Record<string, string>): Promise<Sent> {
  const request = new NextRequest(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: 'not json',
  });
  const response = await post(request);
  return { response, bodyRead: request.bodyUsed };
}

/** Passed authentication: the route read the body and answered its own invalid-body 400. */
async function expectAdmitted(result: Sent) {
  expect(result.response.status).toBe(400);
  expect(await result.response.json()).toEqual({ error: 'Invalid body' });
  expect(result.bodyRead).toBe(true);
}

/** Refused before the body or any writer admission. */
function expectRefusedEarly(result: Sent, status: number) {
  expect(result.response.status).toBe(status);
  expect(result.bodyRead).toBe(false);
  expect(queueAcquire).not.toHaveBeenCalled();
  expect(taggedAcquire).not.toHaveBeenCalled();
}

async function expectLegacyRefusal(result: Sent) {
  expectRefusedEarly(result, 401);
  expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
  expect(result.response.headers.get('www-authenticate')).toBeNull();
}

it('pins the test deployment to the development issuer and a loopback origin', () => {
  expect(STS_URL).toBe(STS_ISSUERS.development);
  expect(['localhost', '127.0.0.1']).toContain(new URL(ORIGIN).hostname);
});

// Declared first: no test before these has fetched the key set, so an empty fetch log shows the
// legacy check did no STS work.
describe.each(ROUTES)('%s with USAGE_RECORD_AUTH absent, empty or legacy', (path, post) => {
  it.each([[undefined], [''], ['legacy']])('keeps the secret check (%p)', async mode => {
    if (mode !== undefined) process.env.USAGE_RECORD_AUTH = mode;
    await expectAdmitted(await send(path, post, secret));
    await expectAdmitted(
      await send(path, post, { 'x-internal-secret': INTERNAL_API_SECRET, ...queue })
    );
    await expectLegacyRefusal(
      await send(path, post, { 'x-internal-api-key': `${INTERNAL_API_SECRET}-wrong` })
    );
    await expectLegacyRefusal(await send(path, post, {}));
    // A valid STS token is not a credential here, and beside the secret it changes nothing.
    await expectLegacyRefusal(await send(path, post, { ...(await bearer()), ...queue }));
    await expectAdmitted(await send(path, post, { ...(await bearer()), ...secret, ...queue }));
    expect(keySetFetches).toEqual([]);
  });
});

describe.each(ROUTES)('%s with USAGE_RECORD_AUTH=dual', (path, post) => {
  const challenge = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${path}"`;

  beforeEach(() => {
    process.env.USAGE_RECORD_AUTH = 'dual';
  });

  it('accepts the internal API secret with every source, independent of STS', async () => {
    await expectAdmitted(await send(path, post, secret));
    await expectAdmitted(await send(path, post, { ...secret, ...queue }));
    await expectAdmitted(
      await send(path, post, { ...secret, 'x-usage-write-source': 'region_handoff' })
    );
    await expectAdmitted(await send(path, post, { 'x-internal-secret': INTERNAL_API_SECRET }));
    expect(mockSecretChecks).toHaveLength(4);
  });

  it('answers no credential with the legacy 401 and the route challenge', async () => {
    const fetchesBefore = keySetFetches.length;
    for (const headers of [{}, queue]) {
      const result = await send(path, post, headers);
      expectRefusedEarly(result, 401);
      expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
      expect(result.response.headers.get('www-authenticate')).toBe(`Bearer ${challenge}`);
      expect(result.response.headers.get('cache-control')).toBe('no-store');
    }
    expect(keySetFetches).toHaveLength(fetchesBefore);
  });

  it('answers an empty or wrong secret exactly as before', async () => {
    await expectLegacyRefusal(await send(path, post, { 'x-internal-api-key': '', ...queue }));
    await expectLegacyRefusal(
      await send(path, post, { 'x-internal-api-key': `${INTERNAL_API_SECRET}-wrong`, ...queue })
    );
    await expectLegacyRefusal(
      await send(path, post, { 'x-internal-secret': `${INTERNAL_API_SECRET}-wrong` })
    );
  });

  it('accepts a usage-ingest web:usage.record token on a queue write', async () => {
    await expectAdmitted(await send(path, post, { ...(await bearer()), ...queue }));
  });

  it.each([['region_handoff'], ['queue_vercel'], [null]])(
    'refuses a valid token sent with source %p',
    async source => {
      const headers = await bearer();
      if (source !== null) headers['x-usage-write-source'] = source;
      const result = await send(path, post, headers);
      expectRefusedEarly(result, 403);
      expect(await result.response.json()).toEqual({
        error: 'insufficient_scope',
        scope: STS_USAGE_RECORD.scope,
      });
      expect(result.response.headers.get('www-authenticate')).toContain(challenge);
    }
  );

  it('refuses a valid token of another workload', async () => {
    const headers = { ...(await bearer({ workload: 'ai-gateway' })), ...queue };
    const result = await send(path, post, headers);
    expectRefusedEarly(result, 403);
    expect(await result.response.json()).toEqual({
      error: 'insufficient_scope',
      scope: STS_USAGE_RECORD.scope,
    });
  });

  it.each([
    ['another audience', { audience: STS_USAGE_PUBLISH.audience, scope: STS_USAGE_PUBLISH.scope }],
    ['another web scope', { scope: 'web:sts.canary' }],
  ])('refuses %s with 403', async (_name, options) => {
    const result = await send(path, post, { ...(await bearer(options)), ...queue });
    expectRefusedEarly(result, 403);
    expect((await result.response.json()) as unknown).toMatchObject({
      error: 'insufficient_scope',
    });
  });

  it.each([
    ['another environment', { env: 'staging' }],
    ['another issuer', { issuer: STS_ISSUERS.staging }],
    ['an expired token', { issuedAt: Math.floor(Date.now() / 1000) - 1_000 }],
  ])('refuses %s with 401 and no fallback to the secret', async (_name, options) => {
    const result = await send(path, post, { ...(await bearer(options)), ...queue });
    expectRefusedEarly(result, 401);
    expect(await result.response.json()).toEqual({ error: 'invalid_token' });
    expect(result.response.headers.get('www-authenticate')).toContain(challenge);
  });

  it('refuses a forged or malformed bearer with 401', async () => {
    const forged = await send(path, post, { ...(await bearer({ key: otherKey })), ...queue });
    expectRefusedEarly(forged, 401);
    expect(await forged.response.json()).toEqual({ error: 'invalid_token' });
    const malformed = await send(path, post, { authorization: 'Bearer not-a-token', ...queue });
    expectRefusedEarly(malformed, 401);
    expect(malformed.response.headers.get('www-authenticate')).toContain(challenge);
  });

  it('refuses both credential families on one request', async () => {
    for (const authorization of [await bearer(), { authorization: 'Bearer not-a-token' }]) {
      const result = await send(path, post, { ...authorization, ...secret, ...queue });
      expectRefusedEarly(result, 400);
      expect(await result.response.json()).toEqual({ error: 'invalid_request' });
    }
  });

  it('without an STS deployment refuses STS tokens with 503 and drops the challenge', async () => {
    // Production labels select the production issuer, which is not this process's STS_URL.
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
    const result = await send(path, post, { ...(await bearer()), ...queue });
    expectRefusedEarly(result, 503);
    expect(await result.response.json()).toEqual({ error: 'Service unavailable' });
    await expectLegacyRefusal(await send(path, post, { ...queue }));
    await expectAdmitted(await send(path, post, { ...secret, ...queue }));
  });
});

describe.each(ROUTES)('%s with USAGE_RECORD_AUTH=sts', (path, post) => {
  const challenge = `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource${path}"`;

  beforeEach(() => {
    process.env.USAGE_RECORD_AUTH = 'sts';
  });

  afterEach(() => {
    // No `sts` request ever reaches the secret comparison.
    expect(mockSecretChecks).toEqual([]);
  });

  it('accepts a usage-ingest web:usage.record token on a queue write', async () => {
    await expectAdmitted(await send(path, post, { ...(await bearer()), ...queue }));
  });

  it.each([
    ['the correct secret', secret],
    ['the correct secret with the queue source', { ...secret, ...queue }],
    ['the region handoff', { ...secret, 'x-usage-write-source': 'region_handoff' }],
    ['x-internal-secret', { 'x-internal-secret': INTERNAL_API_SECRET }],
    ['a wrong secret', { 'x-internal-api-key': `${INTERNAL_API_SECRET}-wrong`, ...queue }],
    ['no credential', queue],
  ])('refuses %s with the 401 and the route challenge', async (_name, headers) => {
    const fetchesBefore = keySetFetches.length;
    const result = await send(path, post, headers);
    expectRefusedEarly(result, 401);
    expect(await result.response.json()).toEqual({ error: 'Unauthorized' });
    expect(result.response.headers.get('www-authenticate')).toBe(`Bearer ${challenge}`);
    expect(result.response.headers.get('cache-control')).toBe('no-store');
    expect(keySetFetches).toHaveLength(fetchesBefore);
  });

  it.each([
    ['another workload', { workload: 'ai-gateway' }, 403, 'insufficient_scope'],
    [
      'another audience',
      { audience: STS_USAGE_PUBLISH.audience, scope: STS_USAGE_PUBLISH.scope },
      403,
      'insufficient_scope',
    ],
    ['another web scope', { scope: 'web:sts.canary' }, 403, 'insufficient_scope'],
    ['another issuer', { issuer: STS_ISSUERS.staging }, 401, 'invalid_token'],
    ['another environment', { env: 'staging' }, 401, 'invalid_token'],
    ['a forged token', { key: otherKey }, 401, 'invalid_token'],
  ])('refuses %s with no fallback to the secret', async (_name, options, status, error) => {
    // `otherKey` is assigned in beforeAll, after `it.each` captured this table.
    const resolved = 'key' in options ? { key: otherKey } : options;
    const result = await send(path, post, { ...(await bearer(resolved)), ...secret, ...queue });
    expectRefusedEarly(result, 400);
    const alone = await send(path, post, { ...(await bearer(resolved)), ...queue });
    expectRefusedEarly(alone, status);
    expect((await alone.response.json()) as unknown).toMatchObject({ error });
    expect(alone.response.headers.get('www-authenticate')).toContain(challenge);
  });

  it('refuses a valid token without the queue source', async () => {
    for (const source of ['region_handoff', 'queue_vercel', null]) {
      const headers = await bearer();
      if (source !== null) headers['x-usage-write-source'] = source;
      const result = await send(path, post, headers);
      expectRefusedEarly(result, 403);
    }
  });

  it('refuses both credential families on one request', async () => {
    const result = await send(path, post, { ...(await bearer()), ...secret, ...queue });
    expectRefusedEarly(result, 400);
    expect(await result.response.json()).toEqual({ error: 'invalid_request' });
  });

  it('without an STS deployment refuses everything with 503, the secret included', async () => {
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
    for (const headers of [{ ...(await bearer()), ...queue }, { ...secret, ...queue }, queue]) {
      const result = await send(path, post, headers);
      expectRefusedEarly(result, 503);
      expect(await result.response.json()).toEqual({ error: 'Service unavailable' });
      expect(result.response.headers.get('www-authenticate')).toBeNull();
    }
  });
});

describe.each(ROUTES)('%s with an unknown USAGE_RECORD_AUTH', (path, post) => {
  it.each([['STS'], ['sts-only'], ['bogus']])('refuses every request with 503 (%p)', async mode => {
    process.env.USAGE_RECORD_AUTH = mode;
    for (const headers of [secret, { ...(await bearer()), ...queue }]) {
      const result = await send(path, post, headers);
      expectRefusedEarly(result, 503);
      expect(await result.response.json()).toEqual({ error: 'Service unavailable' });
    }
  });
});

describe.each([['dual'], ['sts']])('an unreachable STS key set under %s', mode => {
  it('answers STS tokens 503 with Retry-After; only dual admits the secret', async () => {
    process.env.USAGE_RECORD_AUTH = mode;
    keySetUp = false;
    try {
      let authorize: typeof AuthorizeUsageRecordRequest | undefined;
      // A fresh module instance: its verifier holds no key set yet.
      await jest.isolateModulesAsync(async () => {
        authorize = (await import('./usage-record-auth')).authorizeUsageRecordRequest;
      });
      if (authorize === undefined) throw new Error('module did not load');
      const request = (headers: Record<string, string>) =>
        new Request(`${ORIGIN}${EXA_USAGE_WRITE_PATH}`, { method: 'POST', headers });
      const refused = await authorize(
        request({ ...(await bearer()), ...queue }),
        EXA_USAGE_WRITE_PATH
      );
      expect(refused?.status).toBe(503);
      expect(refused?.headers.get('retry-after')).not.toBeNull();
      expect(await refused?.json()).toEqual({ error: 'temporarily_unavailable' });
      const viaSecret = await authorize(request({ ...secret, ...queue }), EXA_USAGE_WRITE_PATH);
      if (mode === 'dual') {
        expect(viaSecret).toBeNull();
      } else {
        expect(viaSecret?.status).toBe(401);
        expect(mockSecretChecks).toEqual([]);
      }
    } finally {
      keySetUp = true;
    }
  });
});

describe('one verifier for the three routes', () => {
  it('fetches the STS key set once and names each route in its challenges', async () => {
    process.env.USAGE_RECORD_AUTH = 'dual';
    let loaded: typeof AuthorizeUsageRecordRequest | undefined;
    let appUrl: string | undefined;
    // A fresh module instance: no verifier and no key set yet.
    await jest.isolateModulesAsync(async () => {
      loaded = (await import('./usage-record-auth')).authorizeUsageRecordRequest;
      appUrl = (await import('@kilocode/web-shared/lib/constants')).APP_URL;
    });
    if (loaded === undefined || appUrl === undefined) throw new Error('module did not load');
    const authorize: typeof AuthorizeUsageRecordRequest = loaded;
    const origin = new URL(appUrl).origin;
    const paths = ROUTES.map(([path]) => path);
    const request = (path: string, headers: Record<string, string>) =>
      new Request(`${origin}${path}`, { method: 'POST', headers });
    const fetchesBefore = keySetFetches.length;

    const cold = await Promise.all(
      paths.map(async path => authorize(request(path, { ...(await bearer()), ...queue }), path))
    );
    expect(cold).toEqual([null, null, null]);

    for (const path of paths) {
      const metadata = `resource_metadata="${origin}/.well-known/oauth-protected-resource${path}"`;
      expect(await authorize(request(path, { ...(await bearer()), ...queue }), path)).toBeNull();

      const forgedHeaders = { ...(await bearer({ key: otherKey })), ...queue };
      const forged = await authorize(request(path, forgedHeaders), path);
      expect(forged?.status).toBe(401);
      expect(await forged?.json()).toEqual({ error: 'invalid_token' });
      expect(forged?.headers.get('www-authenticate')).toBe(
        `Bearer error="invalid_token", ${metadata}`
      );
      expect(forged?.headers.get('cache-control')).toBe('no-store');

      const publish = { audience: STS_USAGE_PUBLISH.audience, scope: STS_USAGE_PUBLISH.scope };
      const otherAudience = await authorize(
        request(path, { ...(await bearer(publish)), ...queue }),
        path
      );
      expect(otherAudience?.status).toBe(403);
      expect((await otherAudience?.json()) as unknown).toMatchObject({
        error: 'insufficient_scope',
      });
      const challenge = otherAudience?.headers.get('www-authenticate') ?? '';
      expect(challenge.startsWith('Bearer error="insufficient_scope"')).toBe(true);
      expect(challenge.endsWith(`, ${metadata}`)).toBe(true);
      expect(otherAudience?.headers.get('cache-control')).toBe('no-store');
    }

    expect(keySetFetches.length - fetchesBefore).toBe(1);
  });
});

describe('an unparsable APP_URL', () => {
  it('is no STS deployment: STS gets 503, no credential the plain legacy 401', async () => {
    process.env.USAGE_RECORD_AUTH = 'dual';
    process.env.PORT = 'not-a-port';
    let authorize: typeof AuthorizeUsageRecordRequest | undefined;
    // A fresh module instance reads `APP_URL` as `http://localhost:not-a-port`.
    await jest.isolateModulesAsync(async () => {
      authorize = (await import('./usage-record-auth')).authorizeUsageRecordRequest;
    });
    if (authorize === undefined) throw new Error('module did not load');
    const request = (headers: Record<string, string>) =>
      new Request(`${ORIGIN}${ENKRYPT_USAGE_WRITE_PATH}`, { method: 'POST', headers });
    const refused = await authorize(
      request({ ...(await bearer()), ...queue }),
      ENKRYPT_USAGE_WRITE_PATH
    );
    expect(refused?.status).toBe(503);
    expect(await refused?.json()).toEqual({ error: 'Service unavailable' });
    const missing = await authorize(request({ ...queue }), ENKRYPT_USAGE_WRITE_PATH);
    expect(missing?.status).toBe(401);
    expect(await missing?.json()).toEqual({ error: 'Unauthorized' });
    expect(missing?.headers.get('www-authenticate')).toBeNull();
    expect(await authorize(request({ ...secret, ...queue }), ENKRYPT_USAGE_WRITE_PATH)).toBeNull();
  });
});

describe('protected-resource metadata', () => {
  const metadata = (product: string) =>
    resourceMetadata(
      new Request(`${ORIGIN}/.well-known/oauth-protected-resource/api/internal/${product}/record`),
      { params: Promise.resolve({ product }) }
    );

  it('is a 404 unless USAGE_RECORD_AUTH is dual or sts', async () => {
    expect((await metadata('usage')).status).toBe(404);
    process.env.USAGE_RECORD_AUTH = 'legacy';
    expect((await metadata('usage')).status).toBe(404);
    process.env.USAGE_RECORD_AUTH = 'bogus';
    expect((await metadata('usage')).status).toBe(404);
  });

  it.each(
    ROUTES.flatMap(([path]) => [
      [path, 'dual'],
      [path, 'sts'],
    ])
  )('describes %s under %s', async (path, mode) => {
    process.env.USAGE_RECORD_AUTH = mode;
    const product = path.split('/')[3];
    const response = await metadata(product);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      resource: `${ORIGIN}${path}`,
      authorization_servers: [STS_ISSUERS.development],
      scopes_supported: [STS_USAGE_RECORD.scope],
      bearer_methods_supported: ['header'],
    });
  });

  it('is a 404 for another product or without a matching STS environment', async () => {
    process.env.USAGE_RECORD_AUTH = 'dual';
    expect((await metadata('sts-canary')).status).toBe(404);
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_TARGET_ENV = 'production';
    expect((await metadata('usage')).status).toBe(404);
  });
});
