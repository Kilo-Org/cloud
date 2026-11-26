import {
  type JWK,
  SignJWT,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type ClientCredentials, readSignInConfig } from '../../src/signin/providers/config';
import {
  authorizationUrl,
  normalizeEmail,
  providerIdentity,
  workosIdentity,
} from '../../src/signin/providers/exchange';
import { PROVIDER_SPECS, type OidcSpec, type ProviderSpec } from '../../src/signin/providers/specs';
import { flowSecrets, returnPathOf } from '../../src/signin/flows';
import { config } from '../runtime/test-env';

/**
 * The provider side of a sign-in: configuration, the authorization request, and the code exchange
 * and identity check against a stand-in provider that `fetch` answers. Every key and value here is
 * synthetic.
 */

const REDIRECT = 'http://localhost:8800/signin/oauth/google/callback';
const FLOW = { state: 'state-value', challenge: 'challenge-value', nonce: 'nonce-value' };
const secret: ClientCredentials = { kind: 'secret', clientId: 'client-1', clientSecret: 'shh' };

function oidcSpec(provider: 'google' | 'openai' | 'apple' | 'anthropic' | 'linkedin'): OidcSpec {
  const spec = PROVIDER_SPECS[provider];
  if (spec.protocol !== 'oidc') throw new Error('not OpenID Connect');
  return spec;
}

describe('authorization request', () => {
  it('sends state, nonce and PKCE S256 to an OpenID Connect provider', () => {
    const url = authorizationUrl(PROVIDER_SPECS.google, 'client-1', REDIRECT, FLOW);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: REDIRECT,
      scope: 'openid email profile',
      state: 'state-value',
      nonce: 'nonce-value',
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
    });
  });

  it('asks Apple for form_post without PKCE, and OpenAI for its resource', () => {
    const apple = authorizationUrl(PROVIDER_SPECS.apple, 'services.id', REDIRECT, FLOW);
    expect(apple.searchParams.get('response_mode')).toBe('form_post');
    expect(apple.searchParams.has('code_challenge')).toBe(false);
    const openai = authorizationUrl(PROVIDER_SPECS.openai, 'client-1', REDIRECT, FLOW);
    expect(openai.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    const linkedin = authorizationUrl(PROVIDER_SPECS.linkedin, 'client-1', REDIRECT, FLOW);
    expect(linkedin.searchParams.has('code_challenge')).toBe(false);
  });

  it('sends PKCE but no nonce to GitHub and Discord, which have no OpenID Connect', () => {
    for (const provider of ['github', 'discord'] as const) {
      const url = authorizationUrl(PROVIDER_SPECS[provider], 'client-1', REDIRECT, FLOW);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.has('nonce')).toBe(false);
    }
  });
});

describe('flow values', () => {
  it('derive the PKCE pair and the nonce from the binder', async () => {
    const binder = 'A'.repeat(43);
    const one = await flowSecrets(binder);
    expect(one).toEqual(await flowSecrets(binder));
    expect(one.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(one.verifier))
    );
    expect(one.challenge).toBe(Buffer.from(digest).toString('base64url'));
    expect(one.nonce).not.toBe(one.verifier);
    expect((await flowSecrets('B'.repeat(43))).verifier).not.toBe(one.verifier);
  });

  it('return only to the issuer sign-in destinations', () => {
    expect(returnPathOf('/authorize?client_id=kilo-cli&state=x')).toBe(
      '/authorize?client_id=kilo-cli&state=x'
    );
    expect(returnPathOf('/device?user_code=ABCD-EFGH')).toBe('/device?user_code=ABCD-EFGH');
    for (const value of [
      null,
      'https://evil.example.com/authorize',
      '//evil.example.com/authorize',
      '/\\evil.example.com',
      '/token',
      '/authorize/../token',
    ]) {
      expect(returnPathOf(value)).toBe('/signin/done');
    }
  });

  it('normalize an address to the identity store form', () => {
    expect(normalizeEmail(' Someone@Example.COM ')).toBe('someone@example.com');
    expect(normalizeEmail('no-at-sign')).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(320)}@example.com`)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});

describe('configuration', () => {
  it('offers a provider only when every value is set, and flags a partial one', () => {
    const settings = readSignInConfig(
      {
        SIGNIN_GOOGLE_CLIENT_ID: 'google-client',
        SIGNIN_GOOGLE_CLIENT_SECRET: 'google-secret',
        SIGNIN_GITHUB_CLIENT_ID: 'github-client',
        SIGNIN_APPLE_CLIENT_ID: 'apple-client',
        SIGNIN_APPLE_TEAM_ID: 'TEAM',
      },
      config
    );
    expect(settings.providers.google).toMatchObject({
      status: 'on',
      credentials: { kind: 'secret', clientId: 'google-client' },
    });
    expect(settings.providers.github).toEqual({
      status: 'misconfigured',
      missing: ['SIGNIN_GITHUB_CLIENT_SECRET'],
    });
    expect(settings.providers.apple).toEqual({
      status: 'misconfigured',
      missing: ['SIGNIN_APPLE_KEY_ID', 'SIGNIN_APPLE_PRIVATE_KEY'],
    });
    expect(settings.providers.discord).toEqual({ status: 'off' });
    expect(settings.sso).toEqual({ status: 'off' });
    expect(settings.emailHashKey).toEqual({ status: 'off' });
  });

  it('accepts local stand-in endpoints in development only', () => {
    const SIGNIN_DEV_ENDPOINTS = JSON.stringify({
      github: {
        authorization: 'http://127.0.0.1:9003/login/oauth/authorize',
        token: 'http://127.0.0.1:9003/login/oauth/access_token',
        api: 'http://127.0.0.1:9003/api',
      },
    });
    const env = {
      SIGNIN_GITHUB_CLIENT_ID: 'id',
      SIGNIN_GITHUB_CLIENT_SECRET: 's',
      SIGNIN_DEV_ENDPOINTS,
    };
    expect(readSignInConfig(env, config).providers.github).toMatchObject({
      spec: { endpoints: { api: 'http://127.0.0.1:9003/api' } },
    });
    // Outside development, or with a remote endpoint, every provider and SSO is misconfigured;
    // the rest of the Worker keeps working.
    const misconfigured = { status: 'misconfigured', missing: ['SIGNIN_DEV_ENDPOINTS'] };
    const staging = readSignInConfig(
      { ...env, SIGNIN_WORKOS_CLIENT_ID: 'client_1', SIGNIN_WORKOS_API_KEY: 'sk_test' },
      { ...config, environment: 'staging' }
    );
    expect(staging.providers.github).toEqual(misconfigured);
    expect(staging.sso).toEqual(misconfigured);
    const remote = JSON.stringify({
      github: {
        authorization: 'https://github.example/a',
        token: 'https://github.example/t',
        api: 'https://github.example',
      },
    });
    expect(
      readSignInConfig({ ...env, SIGNIN_DEV_ENDPOINTS: remote }, config).providers.github
    ).toEqual(misconfigured);
  });
});

type Recorded = { url: string; init: RequestInit | undefined };

/** The body a recorded call sent; every token request here sends a string. */
function bodyOf(call: Recorded): string {
  const body = call.init?.body;
  if (typeof body !== 'string') throw new Error('expected a string body');
  return body;
}

/** Answers `fetch` by URL prefix and records each call. */
function standIn(routes: Record<string, (init: RequestInit | undefined) => Response>) {
  const calls: Recorded[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    const route = Object.keys(routes).find(prefix => url.startsWith(prefix));
    if (route === undefined) throw new TypeError(`no stand-in for ${url}`);
    return routes[route](init);
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

const ISSUER = 'https://idp.test';
let signingKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: 'idp-key', alg: 'RS256', use: 'sig' };
});

function testSpec(overrides: Partial<OidcSpec> = {}): OidcSpec {
  return {
    ...oidcSpec('google'),
    endpoints: {
      issuers: [ISSUER],
      authorization: `${ISSUER}/authorize`,
      token: `${ISSUER}/token`,
      jwks: `${ISSUER}/jwks-${crypto.randomUUID()}`,
    },
    ...overrides,
  };
}

async function idToken(claims: Record<string, unknown>, audience = 'client-1') {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'idp-key' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

function oidcStandIn(spec: OidcSpec, token: string, tokenStatus = 200) {
  return standIn({
    [spec.endpoints.token]: () =>
      Response.json(tokenStatus === 200 ? { id_token: token, access_token: 'at' } : {}, {
        status: tokenStatus,
      }),
    [spec.endpoints.jwks]: () => Response.json({ keys: [publicJwk] }),
  });
}

const callback = { code: 'code-1', redirectUri: REDIRECT, verifier: 'verifier-1', nonce: 'n-1' };

describe('OpenID Connect identity', () => {
  it('verifies the ID token and proves a Gmail or Workspace address only', async () => {
    const spec = testSpec();
    const cases: [Record<string, unknown>, string, boolean][] = [
      [{ email: 'Person@Gmail.com', email_verified: true }, 'person@gmail.com', true],
      [
        { email: 'person@corp.example', email_verified: true, hd: 'corp.example' },
        'person@corp.example',
        true,
      ],
      // A verified address that Google does not host proves nothing.
      [
        { email: 'person@elsewhere.example', email_verified: true },
        'person@elsewhere.example',
        false,
      ],
      [{ email: 'person@gmail.com', email_verified: false }, 'person@gmail.com', false],
    ];
    for (const [claims, email, proven] of cases) {
      oidcStandIn(spec, await idToken({ sub: 'user-1', nonce: 'n-1', ...claims }));
      expect(await providerIdentity(spec, secret, callback)).toEqual({
        status: 'ok',
        identity: { subject: 'user-1', email, emailProven: proven, workosConnectionId: null },
      });
      vi.restoreAllMocks();
    }
  });

  it('sends the code with PKCE and the client secret in the body', async () => {
    const spec = testSpec();
    const calls = oidcStandIn(spec, await idToken({ sub: 'u', nonce: 'n-1' }));
    await providerIdentity(spec, secret, callback);
    const body = new URLSearchParams(bodyOf(calls[0]));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: REDIRECT,
      code_verifier: 'verifier-1',
      client_id: 'client-1',
      client_secret: 'shh',
    });
  });

  it('uses HTTP Basic and repeats the resource for OpenAI', async () => {
    const spec = testSpec({
      clientAuth: 'client_secret_basic',
      resource: 'https://api.openai.com/v1',
    });
    const calls = oidcStandIn(spec, await idToken({ sub: 'u', nonce: 'n-1' }));
    await providerIdentity(spec, secret, callback);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get('Authorization')).toBe(`Basic ${btoa('client-1:shh')}`);
    const body = new URLSearchParams(bodyOf(calls[0]));
    expect(body.get('resource')).toBe('https://api.openai.com/v1');
    expect(body.has('client_secret')).toBe(false);
  });

  it('refuses a wrong nonce, a wrong audience and another issuer', async () => {
    const spec = testSpec();
    for (const token of [
      await idToken({ sub: 'u', nonce: 'other' }),
      await idToken({ sub: 'u', nonce: 'n-1' }, 'another-client'),
    ]) {
      oidcStandIn(spec, token);
      const result = await providerIdentity(spec, secret, callback);
      expect(result).toMatchObject({ status: 'failed', failure: { kind: 'refused' } });
      vi.restoreAllMocks();
    }
    oidcStandIn(
      testSpec({ ...spec, endpoints: { ...spec.endpoints, issuers: ['https://other.test'] } }),
      await idToken({ sub: 'u', nonce: 'n-1' })
    );
    expect(
      await providerIdentity(
        { ...spec, endpoints: { ...spec.endpoints, issuers: ['https://other.test'] } },
        secret,
        callback
      )
    ).toMatchObject({
      status: 'failed',
      failure: { kind: 'refused', reason: 'id_token_ERR_JWT_CLAIM_VALIDATION_FAILED' },
    });
  });

  it('answers a provider outage as retryable and a refused code as final', async () => {
    const spec = testSpec();
    oidcStandIn(spec, '', 503);
    expect(await providerIdentity(spec, secret, callback)).toEqual({
      status: 'failed',
      failure: { kind: 'retryable', reason: 'token_503' },
    });
    vi.restoreAllMocks();
    oidcStandIn(spec, '', 400);
    expect(await providerIdentity(spec, secret, callback)).toEqual({
      status: 'failed',
      failure: { kind: 'refused', reason: 'token_400' },
    });
    vi.restoreAllMocks();
    standIn({});
    expect(await providerIdentity(spec, secret, callback)).toEqual({
      status: 'failed',
      failure: { kind: 'retryable', reason: 'token_unreachable' },
    });
  });

  it('signs Apple a short ES256 client secret', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const pem = await exportPKCS8(pair.privateKey);
    const spec = testSpec({ clientAuth: 'apple_client_secret', pkce: false });
    const calls = oidcStandIn(spec, await idToken({ sub: 'u', nonce: 'n-1' }, 'services.id'));
    const apple: ClientCredentials = {
      kind: 'apple',
      clientId: 'services.id',
      teamId: 'TEAM123',
      keyId: 'KEY123',
      privateKeyPem: pem,
    };
    expect(await providerIdentity(spec, apple, callback)).toMatchObject({ status: 'ok' });
    const body = new URLSearchParams(bodyOf(calls[0]));
    expect(body.has('code_verifier')).toBe(false);
    const clientSecret = body.get('client_secret') ?? '';
    expect(decodeProtectedHeader(clientSecret)).toMatchObject({ alg: 'ES256', kid: 'KEY123' });
    const { payload } = await jwtVerify(clientSecret, pair.publicKey, {
      issuer: 'TEAM123',
      subject: 'services.id',
      audience: 'https://appleid.apple.com',
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  it('sends Claude a JSON body with a private_key_jwt client assertion', async () => {
    const pair = await generateKeyPair('ES256', { extractable: true });
    const spec = testSpec({ clientAuth: 'private_key_jwt_json' });
    const calls = oidcStandIn(spec, await idToken({ sub: 'u', nonce: 'n-1' }, 'claude-client'));
    const assertion: ClientCredentials = {
      kind: 'assertion',
      clientId: 'claude-client',
      audience: 'https://auth.test/app',
      issuer: 'https://kilo.test/federation',
      subject: 'kilo-signin',
      keyId: 'fed-key',
      privateKeyPem: await exportPKCS8(pair.privateKey),
    };
    expect(await providerIdentity(spec, assertion, callback)).toMatchObject({ status: 'ok' });
    expect(new Headers(calls[0].init?.headers).get('Content-Type')).toBe('application/json');
    const body = z
      .looseObject({ client_assertion: z.string() })
      .parse(JSON.parse(bodyOf(calls[0])));
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'claude-client',
      code_verifier: 'verifier-1',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    });
    const jwt = body.client_assertion;
    const { payload } = await jwtVerify(jwt, pair.publicKey, {
      issuer: 'https://kilo.test/federation',
      subject: 'kilo-signin',
      audience: 'https://auth.test/app',
    });
    expect(typeof payload.jti).toBe('string');
  });
});

describe('GitHub and Discord identity', () => {
  const github: ProviderSpec = {
    protocol: 'github',
    endpoints: {
      authorization: 'https://gh.test/authorize',
      token: 'https://gh.test/token',
      api: 'https://api.gh.test',
    },
    scope: 'read:user user:email',
  };

  it('takes GitHub primary address and its verified flag', async () => {
    const calls = standIn({
      'https://gh.test/token': () => Response.json({ access_token: 'gh-token' }),
      'https://api.gh.test/user/emails': () =>
        Response.json([
          { email: 'Other@Example.com', verified: true, primary: false },
          { email: 'Main@Example.com', verified: false, primary: true },
        ]),
      'https://api.gh.test/user': () => Response.json({ id: 4242, login: 'someone' }),
    });
    expect(await providerIdentity(github, secret, callback)).toEqual({
      status: 'ok',
      identity: {
        subject: '4242',
        email: 'main@example.com',
        emailProven: false,
        workosConnectionId: null,
      },
    });
    const userCall = calls.find(call => call.url === 'https://api.gh.test/user');
    const headers = new Headers(userCall?.init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer gh-token');
    expect(headers.get('User-Agent')).toBe('kilo-uts');
  });

  it('refuses a GitHub token answer that carries an error', async () => {
    standIn({ 'https://gh.test/token': () => Response.json({ error: 'bad_verification_code' }) });
    expect(await providerIdentity(github, secret, callback)).toEqual({
      status: 'failed',
      failure: { kind: 'refused', reason: 'token_response' },
    });
  });

  it('takes the Discord verified flag', async () => {
    const discord: ProviderSpec = {
      protocol: 'discord',
      endpoints: {
        authorization: 'https://dc.test/authorize',
        token: 'https://dc.test/token',
        user: 'https://dc.test/users/@me',
      },
      scope: 'identify email',
    };
    standIn({
      'https://dc.test/token': () => Response.json({ access_token: 'dc-token' }),
      'https://dc.test/users/@me': () =>
        Response.json({ id: '80351110224678912', email: 'a@example.com', verified: true }),
    });
    expect(await providerIdentity(discord, secret, callback)).toMatchObject({
      status: 'ok',
      identity: { subject: '80351110224678912', email: 'a@example.com', emailProven: true },
    });
  });
});

describe('WorkOS profile', () => {
  it('buys the profile with the API key and never counts its address as proof', async () => {
    const calls = standIn({
      'https://workos.test/sso/token': () =>
        Response.json({
          access_token: 'w',
          profile: { id: 'prof_1', connection_id: 'conn_1', email: 'Person@Corp.example' },
        }),
    });
    expect(
      await workosIdentity('https://workos.test/sso/token', 'client_1', 'sk_test', 'c')
    ).toEqual({
      status: 'ok',
      identity: {
        subject: 'prof_1',
        email: 'person@corp.example',
        emailProven: false,
        workosConnectionId: 'conn_1',
      },
    });
    expect(Object.fromEntries(new URLSearchParams(bodyOf(calls[0])))).toEqual({
      client_id: 'client_1',
      client_secret: 'sk_test',
      grant_type: 'authorization_code',
      code: 'c',
    });
  });
});
