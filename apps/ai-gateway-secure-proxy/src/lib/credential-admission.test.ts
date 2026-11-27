import { STS_ISSUERS, STS_SECURE_PROXY_FORWARD } from '@kilocode/sts-contracts';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREDENTIAL_ACCEPT_ENV,
  LOCAL_STS_FIXTURE_ENV,
  ORIGIN_ENV,
  PROTECTED_RESOURCE_PATH,
  protectedResourceMetadata,
} from './credential-admission';
import { createSecureProxyHandler } from './secure-proxy';

const originalFetch = global.fetch;
const SHARED_SECRET = 'proxy-secret';
const KID = 'sts-test-1';
const JWKS_PATH = '/.well-known/jwks.json';
const UPSTREAM_URL = 'https://llm.example.com/v1/chat/completions';
const UPSTREAM_BODY = {
  model: 'upstream-model',
  kilo_secure_proxy: { url: UPSTREAM_URL, headers: { authorization: 'Bearer upstream-key' } },
};
const FORWARDED = {
  url: UPSTREAM_URL,
  method: 'POST',
  redirect: 'manual',
  body: JSON.stringify({ model: 'upstream-model' }),
  headers: { authorization: 'Bearer upstream-key', 'content-type': 'application/json' },
};
const ORIGIN = 'https://secure-proxy.test';
const METADATA_URL = `${ORIGIN}${PROTECTED_RESOURCE_PATH}`;
const PRODUCTION_DEPLOYMENT = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_TARGET_ENV: 'production',
  // The per-deployment URL Vercel sets; the challenge must never name it.
  VERCEL_URL: 'secure-proxy-git-branch.vercel.app',
  [ORIGIN_ENV]: ORIGIN,
  [LOCAL_STS_FIXTURE_ENV]: undefined,
};
const OFF_VERCEL = {
  VERCEL: undefined,
  VERCEL_ENV: undefined,
  VERCEL_TARGET_ENV: undefined,
  VERCEL_URL: undefined,
  [ORIGIN_ENV]: undefined,
};

// Synthetic Ed25519 keys: STS serves `trusted`; `foreign` signs under the same kid.
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'EdDSA', use: 'sig' };
  return { privateKey, jwk };
}
const trusted = keyPair();
const foreign = keyPair();

/** A forward token as production STS signs it for the gateway, with `claims` merged in. */
function serviceToken(
  claims: Record<string, unknown> = {},
  key: KeyObject = trusted.privateKey
): string {
  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'EdDSA', typ: 'at+jwt', kid: KID };
  const payload = {
    iss: STS_ISSUERS.production,
    sub: 'service:ai-gateway',
    client_id: 'ai-gateway',
    req: 'ai-gateway',
    aud: STS_SECURE_PROXY_FORWARD.audience,
    scope: STS_SECURE_PROXY_FORWARD.scope,
    env: 'production',
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 300,
    ...claims,
  };
  const input = [header, payload]
    .map(part => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}

function proxyRequest(authorization: string | null, body: unknown = UPSTREAM_BODY): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization !== null) headers.set('authorization', authorization);
  return new Request('https://secure-proxy.example.com/api/proxy', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function urlOf(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

/** Every issuer's key set at its canonical URL; any other URL is the upstream. */
function mockNetwork(options: { keySetStatus?: number; upstream?: () => Response } = {}) {
  const isKeySet = (input: RequestInfo | URL) => urlOf(input).endsWith(JWKS_PATH);
  const fetchMock = vi.fn<typeof fetch>(async input => {
    if (isKeySet(input)) {
      return Response.json({ keys: [trusted.jwk] }, { status: options.keySetStatus ?? 200 });
    }
    return options.upstream?.() ?? new Response('{"ok":true}', { status: 200 });
  });
  global.fetch = fetchMock;
  return {
    count: () => fetchMock.mock.calls.length,
    keySetUrls: () =>
      fetchMock.mock.calls.filter(([input]) => isKeySet(input)).map(([input]) => urlOf(input)),
    forwarded: () =>
      fetchMock.mock.calls
        .filter(([input]) => !isKeySet(input))
        .map(([input, init]) => ({
          url: urlOf(input),
          method: init?.method,
          redirect: init?.redirect,
          body: init?.body,
          headers: Object.fromEntries(new Headers(init?.headers)),
        })),
  };
}

function stubEnv(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

function newHandler() {
  return createSecureProxyHandler({ waitUntil: () => {} });
}

beforeEach(() => {
  stubEnv({
    ...PRODUCTION_DEPLOYMENT,
    KILO_AI_GATEWAY_SECURE_PROXY_SECRET: SHARED_SECRET,
    [CREDENTIAL_ACCEPT_ENV]: undefined,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('credential accept mode', () => {
  it.each(['dual', 'LEGACY-ONLY', ' legacy-only', 'toString', '__proto__'])(
    'refuses every request under the unknown mode %j with 500, before any fetch or body read',
    async mode => {
      stubEnv({ [CREDENTIAL_ACCEPT_ENV]: mode });
      const network = mockNetwork();
      const request = proxyRequest(`Bearer ${SHARED_SECRET}`);

      const response = await newHandler()(request);

      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      await expect(response.json()).resolves.toEqual({ error: 'server_misconfigured' });
      expect(network.count()).toBe(0);
      expect(request.bodyUsed).toBe(false);
    }
  );
});

describe.each([undefined, '', 'legacy-only'])('mode %j (legacy-only)', mode => {
  beforeEach(() => stubEnv({ [CREDENTIAL_ACCEPT_ENV]: mode }));

  it('answers a valid service token with the legacy 401 and fetches no key set', async () => {
    const network = mockNetwork();

    const response = await newHandler()(proxyRequest(`Bearer ${serviceToken()}`));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(network.count()).toBe(0);
  });

  it('answers the legacy 500 without the secret, also to a valid service token', async () => {
    stubEnv({ KILO_AI_GATEWAY_SECURE_PROXY_SECRET: undefined });
    const network = mockNetwork();

    const response = await newHandler()(proxyRequest(`Bearer ${serviceToken()}`));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'Secure proxy secret is not configured',
    });
    expect(network.count()).toBe(0);
  });
});

describe('legacy-and-sts', () => {
  beforeEach(() => stubEnv({ [CREDENTIAL_ACCEPT_ENV]: 'legacy-and-sts' }));

  it('forwards the shared secret exactly as legacy-only does, without the key set', async () => {
    const network = mockNetwork();

    const dual = await newHandler()(proxyRequest(`Bearer ${SHARED_SECRET}`));
    stubEnv({ [CREDENTIAL_ACCEPT_ENV]: 'legacy-only' });
    const legacy = await newHandler()(proxyRequest(`Bearer ${SHARED_SECRET}`));

    expect([dual.status, legacy.status]).toEqual([200, 200]);
    expect(network.forwarded()).toEqual([FORWARDED, FORWARDED]);
    expect(network.keySetUrls()).toEqual([]);
    expect(console.log).toHaveBeenCalledWith('[secure-proxy] Upstream responded', {
      upstreamHost: 'llm.example.com',
      status: 200,
      headersAfterMs: expect.any(Number),
      credential: 'legacy',
    });
  });

  it('forwards a valid ai-gateway token the same way, from the production key set', async () => {
    const network = mockNetwork();

    const response = await newHandler()(proxyRequest(`Bearer ${serviceToken()}`));

    expect(response.status).toBe(200);
    expect(network.forwarded()).toEqual([FORWARDED]);
    expect(network.keySetUrls()).toEqual([`${STS_ISSUERS.production}${JWKS_PATH}`]);
    expect(console.log).toHaveBeenCalledWith('[secure-proxy] Upstream responded', {
      upstreamHost: 'llm.example.com',
      status: 200,
      headersAfterMs: expect.any(Number),
      credential: 'sts',
    });
  });

  it('answers the legacy 500 without the secret, also to a valid service token', async () => {
    stubEnv({ KILO_AI_GATEWAY_SECURE_PROXY_SECRET: undefined });
    const network = mockNetwork();

    const response = await newHandler()(proxyRequest(`Bearer ${serviceToken()}`));

    expect(response.status).toBe(500);
    expect(network.count()).toBe(0);
  });

  it('gives a bearer that is not the secret only the service-token answer', async () => {
    const network = mockNetwork();

    const wrong = await newHandler()(proxyRequest(`Bearer ${SHARED_SECRET}-other`));
    const missing = await newHandler()(proxyRequest(null));

    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: 'invalid_token' });
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`
    );
    expect(network.forwarded()).toEqual([]);
  });

  it('without an STS origin, forwards the secret and answers 500 to the rest', async () => {
    stubEnv({ [ORIGIN_ENV]: undefined });
    const network = mockNetwork();
    const handler = newHandler();

    const secret = await handler(proxyRequest(`Bearer ${SHARED_SECRET}`));
    const missing = await handler(proxyRequest(null));
    const service = await handler(proxyRequest(`Bearer ${serviceToken()}`));

    expect([secret.status, missing.status, service.status]).toEqual([200, 500, 500]);
    await expect(missing.json()).resolves.toEqual({ error: 'server_misconfigured' });
    expect(network.forwarded()).toEqual([FORWARDED]);
    expect(network.keySetUrls()).toEqual([]);
  });
});

describe('disabled', () => {
  beforeEach(() => stubEnv({ [CREDENTIAL_ACCEPT_ENV]: 'disabled' }));

  it.each([
    ['the shared secret', `Bearer ${SHARED_SECRET}`],
    ['a valid service token', `Bearer ${serviceToken()}`],
    ['no credential', null],
  ])('refuses %s with the legacy 401, before the body or any fetch', async (_name, auth) => {
    const network = mockNetwork();
    const request = proxyRequest(auth);

    const response = await newHandler()(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
    expect(network.count()).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });
});

describe('sts-only', () => {
  beforeEach(() => stubEnv({ [CREDENTIAL_ACCEPT_ENV]: 'sts-only' }));

  it('forwards a valid ai-gateway service token with no shared secret configured', async () => {
    stubEnv({ KILO_AI_GATEWAY_SECURE_PROXY_SECRET: undefined });
    const network = mockNetwork();

    const response = await newHandler()(proxyRequest(`Bearer ${serviceToken()}`));

    expect(response.status).toBe(200);
    expect(network.forwarded()).toEqual([FORWARDED]);
  });

  it('refuses the shared secret while it is still configured', async () => {
    const network = mockNetwork();
    const request = proxyRequest(`Bearer ${SHARED_SECRET}`);

    const response = await newHandler()(request);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_token' });
    expect(network.forwarded()).toEqual([]);
    expect(request.bodyUsed).toBe(false);
  });
});

const REFUSALS: [string, () => string, number, string][] = [
  ['another audience', () => serviceToken({ aud: 'web' }), 403, 'audience'],
  [
    'an unregistered scope of this audience',
    () => serviceToken({ scope: 'ai-gateway-secure-proxy:request.replay' }),
    403,
    'scope_unknown',
  ],
  [
    'another workload',
    () => serviceToken({ sub: 'service:web', client_id: 'web', req: 'web' }),
    403,
    'workload',
  ],
  ['a user subject', () => serviceToken({ sub: 'user:1' }), 401, 'identity'],
  ['the staging env claim', () => serviceToken({ env: 'staging' }), 401, 'environment'],
  [
    'the staging issuer',
    () => serviceToken({ iss: STS_ISSUERS.staging, env: 'staging' }),
    401,
    'issuer',
  ],
  [
    'an expired token',
    () => {
      // A full 300-second lifetime that ended past the 60-second skew.
      const iat = Math.floor(Date.now() / 1000) - 700;
      return serviceToken({ iat, exp: iat + 300 });
    },
    401,
    'expired',
  ],
  ['a foreign signature', () => serviceToken({}, foreign.privateKey), 401, 'signature'],
];

describe.each(['legacy-and-sts', 'sts-only'])('%s refuses before body and upstream', mode => {
  it.each(REFUSALS)('%s', async (_name, token, status, reason) => {
    stubEnv({ [CREDENTIAL_ACCEPT_ENV]: mode });
    const network = mockNetwork();
    const credential = token();
    const request = proxyRequest(`Bearer ${credential}`);

    const response = await newHandler()(request);

    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(network.forwarded()).toEqual([]);
    expect(request.bodyUsed).toBe(false);
    expect(console.warn).toHaveBeenCalledWith('[secure-proxy] Rejected service token', {
      status,
      reason,
    });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(credential);
  });
});

const INVALID_ORIGINS = [
  'http://secure-proxy.test',
  'https://secure-proxy.test/',
  'https://secure-proxy.test/api',
  'https://secure-proxy.test?x=1',
  'https://secure-proxy.test#x',
  'https://user:pass@secure-proxy.test',
  'https://SECURE-PROXY.test',
  'https://secure-proxy.test:443',
  'secure-proxy.test',
  '',
];

const NO_DEPLOYMENT: [string, Record<string, string | undefined>][] = [
  ['a preview', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' }],
  ['a production target outside production', { VERCEL_ENV: 'preview' }],
  ['a staging target in production', { VERCEL_TARGET_ENV: 'staging' }],
  ['a deployment without the configured origin', { [ORIGIN_ENV]: undefined }],
  ...INVALID_ORIGINS.map((value): [string, Record<string, string>] => [
    `the origin ${JSON.stringify(value)}`,
    { [ORIGIN_ENV]: value },
  ]),
  ['the local fixture switch on Vercel', { [LOCAL_STS_FIXTURE_ENV]: '1' }],
  ['a local process without the fixture switch', OFF_VERCEL],
  [
    'the local fixture with an origin that is not https',
    { ...OFF_VERCEL, [LOCAL_STS_FIXTURE_ENV]: '1', [ORIGIN_ENV]: 'http://localhost:3020' },
  ],
];

describe('the STS environment comes from the deployment labels', () => {
  beforeEach(() => stubEnv({ [CREDENTIAL_ACCEPT_ENV]: 'sts-only' }));

  it('a staging deployment accepts only staging tokens, from the staging key set', async () => {
    stubEnv({ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' });
    const network = mockNetwork();
    const handler = newHandler();

    const staging = await handler(
      proxyRequest(`Bearer ${serviceToken({ iss: STS_ISSUERS.staging, env: 'staging' })}`)
    );
    const production = await handler(proxyRequest(`Bearer ${serviceToken()}`));

    expect([staging.status, production.status]).toEqual([200, 401]);
    expect(network.keySetUrls()).toEqual([`${STS_ISSUERS.staging}${JWKS_PATH}`]);
    expect(network.forwarded()).toEqual([FORWARDED]);
  });

  it('the local fixture switch off Vercel accepts only development tokens', async () => {
    stubEnv({ ...OFF_VERCEL, [LOCAL_STS_FIXTURE_ENV]: '1' });
    const network = mockNetwork();
    const handler = newHandler();

    const development = await handler(
      proxyRequest(`Bearer ${serviceToken({ iss: STS_ISSUERS.development, env: 'development' })}`)
    );
    const production = await handler(proxyRequest(`Bearer ${serviceToken()}`));
    const missing = await handler(proxyRequest(null));

    expect([development.status, production.status]).toEqual([200, 401]);
    expect(network.keySetUrls()).toEqual([`${STS_ISSUERS.development}${JWKS_PATH}`]);
    expect(missing.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="http://localhost:3020${PROTECTED_RESOURCE_PATH}"`
    );
  });

  it.each(NO_DEPLOYMENT)('%s: every service token gets 500, no fetch', async (_name, labels) => {
    stubEnv(labels);
    const network = mockNetwork();
    const request = proxyRequest(`Bearer ${serviceToken()}`);

    const response = await newHandler()(request);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'server_misconfigured' });
    expect(network.count()).toBe(0);
    expect(request.bodyUsed).toBe(false);
  });
});

describe('protected-resource metadata', () => {
  it('names the configured origin, this environment issuer and the forward scope', async () => {
    stubEnv({ [CREDENTIAL_ACCEPT_ENV]: 'sts-only' });
    const network = mockNetwork();

    const challenge = await newHandler()(proxyRequest(null));
    const metadata = protectedResourceMetadata();

    expect(challenge.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA_URL}"`
    );
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get('cache-control')).toBe('no-store');
    await expect(metadata.json()).resolves.toEqual({
      resource: ORIGIN,
      authorization_servers: [STS_ISSUERS.production],
      scopes_supported: [STS_SECURE_PROXY_FORWARD.scope],
      bearer_methods_supported: ['header'],
    });
    expect(network.count()).toBe(0);
  });

  it('names the staging issuer on a staging deployment', async () => {
    stubEnv({
      [CREDENTIAL_ACCEPT_ENV]: 'legacy-and-sts',
      VERCEL_ENV: 'preview',
      VERCEL_TARGET_ENV: 'staging',
    });

    await expect(protectedResourceMetadata().json()).resolves.toMatchObject({
      resource: ORIGIN,
      authorization_servers: [STS_ISSUERS.staging],
    });
  });

  it.each([
    ['mode unset', { [CREDENTIAL_ACCEPT_ENV]: undefined }],
    ['legacy-only', { [CREDENTIAL_ACCEPT_ENV]: 'legacy-only' }],
    ['disabled', { [CREDENTIAL_ACCEPT_ENV]: 'disabled' }],
    ['an unknown mode', { [CREDENTIAL_ACCEPT_ENV]: 'dual' }],
    ['a preview', { [CREDENTIAL_ACCEPT_ENV]: 'sts-only', VERCEL_TARGET_ENV: 'preview' }],
    ['no origin', { [CREDENTIAL_ACCEPT_ENV]: 'sts-only', [ORIGIN_ENV]: undefined }],
    ['an origin with a path', { [CREDENTIAL_ACCEPT_ENV]: 'sts-only', [ORIGIN_ENV]: METADATA_URL }],
  ])('is a plain 404 under %s', async (_name, values) => {
    stubEnv(values);

    const metadata = protectedResourceMetadata();

    expect(metadata.status).toBe(404);
    await expect(metadata.text()).resolves.toBe('');
  });
});

describe('an admitted service token', () => {
  beforeEach(() => stubEnv({ [CREDENTIAL_ACCEPT_ENV]: 'sts-only' }));

  it('answers 503 with Retry-After while the key set is down, one fetch only', async () => {
    const network = mockNetwork({ keySetStatus: 500 });

    const response = await newHandler()(proxyRequest(`Bearer ${serviceToken()}`));

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/);
    expect(network.keySetUrls()).toHaveLength(1);
    expect(network.forwarded()).toEqual([]);
  });

  it('still needs a valid body: `{}` is the exact validation 400', async () => {
    const network = mockNetwork();

    const response = await newHandler()(proxyRequest(`Bearer ${serviceToken()}`, {}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid secure proxy request' });
    expect(network.forwarded()).toEqual([]);
  });

  it('still turns an upstream redirect into a 502 without following it', async () => {
    const network = mockNetwork({
      upstream: () =>
        new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com' } }),
    });

    const response = await newHandler()(proxyRequest(`Bearer ${serviceToken()}`));

    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error:
        'Upstream responded with a redirect (HTTP 307), which the secure proxy does not follow',
    });
    expect(network.forwarded()).toEqual([FORWARDED]);
  });
});
