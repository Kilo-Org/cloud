import { createVerifier, type JwksSource } from '@kilocode/verify';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  RELAY_AUTHORIZATION_HEADER,
  bearerIssuer,
  createRelay,
  type RelayDeps,
  type RelayLog,
  type RelayRequest,
  type StsVerifier,
} from '../src/relay';

const PRODUCTION_ISSUER = 'https://sts.test';
const STAGING_ISSUER = 'https://sts-staging.test';
const SHA = 'c'.repeat(40);
const TREE = `/migration-proxy/repos/Kilo-Org/cloud/git/trees/${SHA}`;
const INSTALLATION_TOKEN = 'ghs_installationtokenvalue';

type Issuer = {
  issuer: string;
  environment: 'staging' | 'production';
  kid: string;
  key: CryptoKey;
  jwks: JwksSource;
};

async function issuer(url: string, environment: Issuer['environment']): Promise<Issuer> {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  const body = { keys: [{ ...jwk, kid, alg: 'EdDSA', use: 'sig' }] };
  return {
    issuer: url,
    environment,
    kid,
    key: privateKey,
    jwks: async () => ({ body, age: 0, oldestAge: 0 }),
  };
}

let production: Issuer;
let staging: Issuer;
beforeAll(async () => {
  production = await issuer(PRODUCTION_ISSUER, 'production');
  staging = await issuer(STAGING_ISSUER, 'staging');
});

async function stsToken(from: Issuer, overrides: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    iss: from.issuer,
    exp: now + 300,
    aud: 'github-relay',
    sub: 'service:migration-proxy',
    client_id: 'migration-proxy',
    iat: now,
    jti: crypto.randomUUID(),
    scope: 'github-relay:migration-proxy.read',
    req: 'migration-proxy',
    env: from.environment,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: from.kid })
    .sign(from.key);
}

function verifierOf(from: Issuer): StsVerifier {
  return {
    issuer: from.issuer,
    environment: from.environment,
    verifier: createVerifier({
      audience: 'github-relay',
      environment: from.environment,
      resourceMetadataUrl: 'https://github-relay.test/.well-known/oauth-protected-resource',
      sts: { issuer: from.issuer, jwks: from.jwks },
    }),
  };
}

type Upstream = { url: string; init: RequestInit };

function setup(
  answer: (url: string, init: RequestInit) => Promise<Response>,
  extra: Partial<RelayDeps> = {}
) {
  const upstream: Upstream[] = [];
  const logs: RelayLog[] = [];
  const relay = createRelay({
    verifiers: [verifierOf(production), verifierOf(staging)],
    fetch: async (url, init) => {
      upstream.push({ url, init });
      return await answer(url, init);
    },
    log: line => logs.push({ ...line }),
    waitUntil: promise => void promise.catch(() => undefined),
    ...extra,
  });
  return { relay, upstream, logs };
}

function request(
  target: string,
  headers: Record<string, string>,
  overrides: Partial<RelayRequest> = {}
): RelayRequest {
  return {
    method: 'GET',
    target,
    headers: new Headers(headers),
    hasBody: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

const githubTree = () =>
  Response.json(
    { sha: SHA, truncated: false, tree: [] },
    {
      headers: {
        'x-ratelimit-remaining': '4999',
        'set-cookie': 'session=abc',
        'x-github-request-id': 'ABCD',
      },
    }
  );

describe('the relay', () => {
  it('forwards an allowed read with the caller GitHub token, never its STS token, and passes the answer back', async () => {
    const { relay, upstream, logs } = setup(async () => githubTree());
    const token = await stsToken(production);
    const response = await relay(
      request(`${TREE}`, {
        [RELAY_AUTHORIZATION_HEADER]: `Bearer ${token}`,
        authorization: `token ${INSTALLATION_TOKEN}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        cookie: 'x=1',
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha: SHA, truncated: false, tree: [] });
    expect(response.headers.get('x-ratelimit-remaining')).toBe('4999');
    expect(response.headers.get('x-github-request-id')).toBe('ABCD');
    expect(response.headers.get('set-cookie')).toBeNull();

    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toBe(`https://api.github.com/repos/Kilo-Org/cloud/git/trees/${SHA}`);
    expect(upstream[0].init).toMatchObject({ method: 'GET', redirect: 'manual' });
    const sent = new Headers(upstream[0].init.headers);
    expect([...sent.keys()].sort()).toEqual([
      'accept',
      'authorization',
      'user-agent',
      'x-github-api-version',
    ]);
    expect(sent.get('authorization')).toBe(`token ${INSTALLATION_TOKEN}`);
    expect(sent.get('user-agent')).toBe('kilo-github-relay (migration-proxy)');

    expect(logs).toEqual([
      expect.objectContaining({
        method: 'GET',
        route: 'tree',
        caller: 'migration-proxy',
        environment: 'production',
        status: 200,
        reason: null,
      }),
    ]);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(SHA);
    expect(logged).not.toContain(INSTALLATION_TOKEN);
    expect(logged).not.toContain(token);
  });

  it('accepts a staging STS token through the staging verifier', async () => {
    const { relay, logs } = setup(async () => githubTree());
    const response = await relay(
      request(TREE, {
        [RELAY_AUTHORIZATION_HEADER]: `Bearer ${await stsToken(staging)}`,
        authorization: `token ${INSTALLATION_TOKEN}`,
      })
    );
    expect(response.status).toBe(200);
    expect(logs[0]).toMatchObject({ environment: 'staging', caller: 'migration-proxy' });
  });

  it('refuses a request without an STS token with 401 and the challenge, before calling GitHub', async () => {
    const { relay, upstream, logs } = setup(async () => githubTree());
    const response = await relay(request(TREE, { authorization: `token ${INSTALLATION_TOKEN}` }));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
    expect(upstream).toEqual([]);
    expect(logs[0]).toMatchObject({ route: 'tree', caller: null, status: 401 });
  });

  it('does not take a GitHub token in Authorization as the STS token', async () => {
    const { relay, upstream } = setup(async () => githubTree());
    const token = await stsToken(production);
    const response = await relay(request(TREE, { authorization: `Bearer ${token}` }));
    expect(response.status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it.each([
    ['another workload', { sub: 'service:web', client_id: 'web', req: 'web' }, 403],
    ['another audience', { aud: 'session-ingest' }, 403],
    [
      'an expired token',
      { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 900 },
      401,
    ],
    ['the wrong environment claim', { env: 'staging' }, 401],
  ])('refuses %s', async (_label, overrides, status) => {
    const { relay, upstream } = setup(async () => githubTree());
    const response = await relay(
      request(TREE, {
        [RELAY_AUTHORIZATION_HEADER]: `Bearer ${await stsToken(production, overrides)}`,
        authorization: `token ${INSTALLATION_TOKEN}`,
      })
    );
    expect(response.status).toBe(status);
    expect(upstream).toEqual([]);
  });

  it('refuses a token signed by an issuer it does not serve', async () => {
    const stranger = await issuer('https://sts.example', 'production');
    const { relay, upstream } = setup(async () => githubTree());
    const response = await relay(
      request(TREE, {
        [RELAY_AUTHORIZATION_HEADER]: `Bearer ${await stsToken(stranger)}`,
        authorization: `token ${INSTALLATION_TOKEN}`,
      })
    );
    expect(response.status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it.each([
    ['POST', { method: 'POST' }, 405],
    ['HEAD', { method: 'HEAD' }, 405],
    ['a body', { hasBody: true }, 400],
  ])(
    'refuses %s from an authenticated caller without calling GitHub',
    async (_label, overrides, status) => {
      const { relay, upstream } = setup(async () => githubTree());
      const response = await relay(
        request(
          TREE,
          {
            [RELAY_AUTHORIZATION_HEADER]: `Bearer ${await stsToken(production)}`,
            authorization: `token ${INSTALLATION_TOKEN}`,
          },
          overrides
        )
      );
      expect(response.status).toBe(status);
      expect(upstream).toEqual([]);
    }
  );

  it('never calls GitHub without the caller GitHub token', async () => {
    const { relay, upstream } = setup(async () => githubTree());
    const response = await relay(
      request(TREE, { [RELAY_AUTHORIZATION_HEADER]: `Bearer ${await stsToken(production)}` })
    );
    expect(response.status).toBe(400);
    expect(upstream).toEqual([]);
  });

  it('refuses a path off the allow-list with 403, never 404, before verifying anything', async () => {
    const { relay, upstream, logs } = setup(async () => githubTree());
    const response = await relay(
      request('/migration-proxy/app/installations/186479258/access_tokens', {}, { method: 'POST' })
    );
    expect(response.status).toBe(403);
    expect(upstream).toEqual([]);
    expect(logs[0]).toMatchObject({ route: null, status: 403, reason: 'path_not_allowed' });
  });

  it('answers 502 when GitHub cannot be reached, and when GitHub does not answer in time', async () => {
    const headers = async () => ({
      [RELAY_AUTHORIZATION_HEADER]: `Bearer ${await stsToken(production)}`,
      authorization: `token ${INSTALLATION_TOKEN}`,
    });
    const refused = setup(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await refused.relay(request(TREE, await headers()))).status).toBe(502);

    const hanging = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      { timeoutMs: 20 }
    );
    expect((await hanging.relay(request(TREE, await headers()))).status).toBe(502);
  });

  it('passes a GitHub redirect and a 304 through without a body', async () => {
    const auth = {
      [RELAY_AUTHORIZATION_HEADER]: `Bearer ${await stsToken(production)}`,
      authorization: `token ${INSTALLATION_TOKEN}`,
    };
    const moved = setup(
      async () => new Response('', { status: 301, headers: { location: 'https://evil.example/' } })
    );
    const redirect = await moved.relay(request(TREE, auth));
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBeNull();
    const cached = setup(async () => new Response(null, { status: 304, headers: { etag: '"x"' } }));
    const notModified = await cached.relay(request(TREE, auth));
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('etag')).toBe('"x"');
    expect(notModified.body).toBeNull();
  });

  it('answers 503 with Retry-After past its in-flight limit, and frees the slot when a body is read', async () => {
    const auth = {
      [RELAY_AUTHORIZATION_HEADER]: `Bearer ${await stsToken(production)}`,
      authorization: `token ${INSTALLATION_TOKEN}`,
    };
    const { relay, upstream } = setup(async () => githubTree(), { maxInFlight: 1 });
    const first = await relay(request(TREE, auth));
    expect(first.status).toBe(200);
    const busy = await relay(request(TREE, auth));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect(upstream).toHaveLength(1);
    await first.text();
    expect((await relay(request(TREE, auth))).status).toBe(200);
  });

  it('answers /healthz without credentials or a log line', async () => {
    const { relay, logs } = setup(async () => githubTree());
    const response = await relay(request('/healthz', {}));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok\n');
    expect(logs).toEqual([]);
  });

  it('logs no token, path parameter or query on any refusal either', async () => {
    const { relay, logs } = setup(async () => githubTree());
    const token = await stsToken(production);
    const other = await stsToken(production, { sub: 'service:web', client_id: 'web', req: 'web' });
    const target = `/migration-proxy/repos/Kilo-Org/cloud/compare/${SHA}...main?per_page=7`;
    const cases: RelayRequest[] = [
      request(`/migration-proxy/repos/Kilo-Org/cloud/git/trees/${SHA}?recursive=1`, {
        [RELAY_AUTHORIZATION_HEADER]: `Bearer ${token}`,
        authorization: `token ${INSTALLATION_TOKEN}`,
      }),
      request(TREE, {
        [RELAY_AUTHORIZATION_HEADER]: `Bearer ${token}x`,
        authorization: `token ${INSTALLATION_TOKEN}`,
      }),
      request(TREE, {
        [RELAY_AUTHORIZATION_HEADER]: `Bearer ${other}`,
        authorization: `token ${INSTALLATION_TOKEN}`,
      }),
      request(TREE, { authorization: `Bearer ${token}` }),
      request(target, { [RELAY_AUTHORIZATION_HEADER]: `Bearer ${token}` }),
      request(
        target,
        {
          [RELAY_AUTHORIZATION_HEADER]: `Bearer ${token}`,
          authorization: `token ${INSTALLATION_TOKEN}`,
        },
        { method: 'POST' }
      ),
    ];
    for (const entry of cases) await relay(entry);
    expect(logs.map(line => [line.status, line.reason])).toEqual([
      [403, 'query_not_allowed'],
      [401, expect.any(String)],
      [403, 'caller_not_allowed'],
      [401, expect.any(String)],
      [400, 'github_authorization_missing'],
      [405, 'method_not_allowed'],
    ]);
    const logged = JSON.stringify(logs);
    for (const secret of [token, other, INSTALLATION_TOKEN, SHA, 'per_page', 'recursive']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('bearerIssuer', () => {
  it('reads the unverified iss of a bearer JWT, and nothing else', async () => {
    expect(bearerIssuer(`Bearer ${await stsToken(staging)}`)).toBe(STAGING_ISSUER);
    expect(bearerIssuer(null)).toBeNull();
    expect(bearerIssuer('Bearer not-a-jwt')).toBeNull();
    expect(bearerIssuer(`token ${INSTALLATION_TOKEN}`)).toBeNull();
    expect(bearerIssuer('Bearer a.b')).toBeNull();
  });
});
