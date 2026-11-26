import {
  KILO_API_MCP_READ_SCOPE,
  KILO_MCP_CATALOG_READ_SCOPE,
  TokenExchangeResponseSchema,
  TokenExchangeSlowDownSchema,
  UTS_ACCESS_TOKEN_TYPE_URN,
  UTS_GRANT_TYPES,
  UtsAccessTokenClaimsSchema,
  UtsPublicJwkSchema,
} from '@kilocode/uts-contracts';
import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from 'jose';
import { describe, expect, it } from 'vitest';
import type { AccessTokenKeys } from '../../src/account/bearer';
import {
  type ExchangeService,
  type StsCallerCheck,
  type StsCallerVerifier,
} from '../../src/exchange/endpoint';
import { newExchangeWindows } from '../../src/exchange/limits';
import type { DelegatedExchangeInput } from '../../src/grants/store';
import { handleOAuthRequest } from '../../src/oauth/routes';
import type { SignerAccess } from '../../src/token/mint';
import { errorOf, fakeGrants, formRequest, oauthDeps, storeFailure } from './oauth-support';
import { keySet } from './support';
import { config } from './test-env';

/**
 * The RFC 8693 broker exchange at `/token` (src/exchange/endpoint.ts) with a stand-in STS
 * verifier, a subject key the test holds, a recording grant store and the test pool's real signer
 * objects for the result.
 */

const THIRD_PARTY = 'https://client.example.com/oauth/client.json';
const ACCOUNT = 'exchange/runtime-user';
const API_ORIGIN = 'http://localhost:3000';
const caller: StsCallerCheck = {
  status: 'verified',
  caller: { workload: 'kilo-mcp', scope: 'uts:token-exchange' },
};

const subjectKey = await (async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = `uts-token-05-${await calculateJwkThumbprint(jwk, 'sha256')}`;
  return {
    privateKey,
    kid,
    key: UtsPublicJwkSchema.parse({ ...jwk, kid, alg: 'EdDSA', use: 'sig' }),
  };
})();

const subjectKeys: AccessTokenKeys = async kid =>
  kid === subjectKey.kid ? { status: 'found', key: subjectKey.key } : { status: 'unknown' };

type SubjectClaims = Record<string, unknown> & { iat: number; exp: number };

/** A subject token of `kilo-mcp:catalog.read`, valid 10 minutes unless `overrides` says otherwise. */
async function subjectToken(overrides: Partial<SubjectClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: config.endpoints.issuer,
    aud: 'kilo-mcp',
    sub: ACCOUNT,
    client_id: THIRD_PARTY,
    jti: crypto.randomUUID(),
    scope: KILO_MCP_CATALOG_READ_SCOPE,
    sid: crypto.randomUUID(),
    auth_time: now - 120,
    amr: ['passkey'],
    env: 'development',
    iat: now,
    exp: now + 600,
    ...overrides,
  };
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: subjectKey.kid })
    .sign(subjectKey.privateKey);
}

function exchangeService(overrides: Partial<ExchangeService> = {}): ExchangeService {
  return {
    callers: async () => caller,
    keys: subjectKeys,
    windows: newExchangeWindows(),
    now: Date.now,
    ...overrides,
  };
}

async function exchangeRequest(
  subject: string,
  fields: Record<string, string> = {},
  authorization: string | null = 'Bearer sts.caller.token'
): Promise<Request> {
  return formRequest(
    '/token',
    {
      grant_type: UTS_GRANT_TYPES.tokenExchange,
      subject_token: subject,
      subject_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
      requested_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
      resource: API_ORIGIN,
      scope: KILO_API_MCP_READ_SCOPE,
      ...fields,
    },
    authorization === null ? {} : { Authorization: authorization }
  );
}

const issuedStore = () =>
  fakeGrants({
    exchangeDelegated: async () => ({ outcome: 'issued', tokenId: crypto.randomUUID() }),
  });

async function call(
  request: Request,
  grants = issuedStore(),
  exchange: ExchangeService | null = exchangeService(),
  sign?: SignerAccess
): Promise<Response> {
  const response = await handleOAuthRequest(
    request,
    '/token',
    oauthDeps(grants.access, { exchange, ...(sign === undefined ? {} : { sign }) })
  );
  if (response === null) throw new Error('the token endpoint did not answer');
  return response;
}

describe('the broker exchange', () => {
  it('issues kilo-api:mcp.read for the subject with act kilo-mcp, its client, sid and org, for 300 seconds', async () => {
    const org = '4b7f8c2e-2f7a-4c1d-9a6e-3c5b1d2e7f80';
    const sid = crypto.randomUUID();
    const subject = await subjectToken({ sid, org });
    const tokenId = crypto.randomUUID();
    const grants = fakeGrants({
      exchangeDelegated: async () => ({ outcome: 'issued', tokenId }),
    });
    const response = await call(await exchangeRequest(subject), grants);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = TokenExchangeResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      issued_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
      token_type: 'Bearer',
      expires_in: 300,
      scope: KILO_API_MCP_READ_SCOPE,
    });
    const { payload } = await jwtVerify(body.access_token, createLocalJWKSet(await keySet()), {
      issuer: config.endpoints.issuer,
      audience: 'kilo-api',
      typ: 'at+jwt',
    });
    const claims = UtsAccessTokenClaimsSchema.parse(payload);
    expect(claims).toMatchObject({
      sub: ACCOUNT,
      client_id: THIRD_PARTY,
      sid,
      org,
      scope: KILO_API_MCP_READ_SCOPE,
      act: { sub: 'kilo-mcp' },
      req: 'kilo-mcp',
      amr: ['passkey'],
      env: 'development',
    });
    expect(claims.exp - claims.iat).toBe(300);
    const [statement] = grants.calls;
    expect(statement.method).toBe('exchangeDelegated');
    const input = statement.input as DelegatedExchangeInput;
    expect(input).toMatchObject({
      clientKind: 'third_party',
      accountId: ACCOUNT,
      clientId: THIRD_PARTY,
      grantId: sid,
      orgId: org,
      subjectScope: KILO_MCP_CATALOG_READ_SCOPE,
      subjectKid: subjectKey.kid,
      scope: KILO_API_MCP_READ_SCOPE,
      actor: 'kilo-mcp',
      lifetimeSeconds: 300,
    });
    // The statement named the token id in its audit row, and the signed token carries it.
    expect(claims.jti).toBe(tokenId);
    expect(grants.calls).toHaveLength(1);
  });

  it('carries no org when the subject has none, never a new one, and serves a kilo-cli subject', async () => {
    const subject = await subjectToken({ client_id: 'kilo-cli' });
    const grants = issuedStore();
    const response = await call(await exchangeRequest(subject), grants);
    expect(response.status).toBe(200);
    const body = TokenExchangeResponseSchema.parse(await response.json());
    const claims = UtsAccessTokenClaimsSchema.parse(
      (await jwtVerify(body.access_token, createLocalJWKSet(await keySet()))).payload
    );
    expect(claims.org).toBeUndefined();
    expect(claims.client_id).toBe('kilo-cli');
    expect((grants.calls[0].input as DelegatedExchangeInput).clientKind).toBe('first_party');
  });

  it('caps the lifetime at the subject token, and refuses one with under 30 seconds left', async () => {
    const now = Math.floor(Date.now() / 1000);
    const short = await call(await exchangeRequest(await subjectToken({ exp: now + 100 })));
    expect(short.status).toBe(200);
    const body = TokenExchangeResponseSchema.parse(await short.json());
    expect(body.expires_in).toBeLessThanOrEqual(100);
    expect(body.expires_in).toBeGreaterThan(90);

    const grants = issuedStore();
    const nearlyOver = await call(
      await exchangeRequest(await subjectToken({ exp: now + 20 })),
      grants
    );
    expect(nearlyOver.status).toBe(400);
    expect(await errorOf(nearlyOver)).toBe('invalid_grant');
    const expired = await call(
      await exchangeRequest(await subjectToken({ iat: now - 700, exp: now - 100 })),
      grants
    );
    expect(await errorOf(expired)).toBe('invalid_grant');
    expect(grants.calls).toEqual([]);
  });

  it.each<[string, StsCallerCheck | null, number, string]>([
    ['no bearer', null, 401, 'invalid_client'],
    ['an invalid STS token', { status: 'invalid' }, 401, 'invalid_client'],
    [
      'another workload',
      { status: 'verified', caller: { workload: 'web', scope: 'uts:token-exchange' } },
      401,
      'invalid_client',
    ],
    [
      'another STS scope',
      { status: 'verified', caller: { workload: 'kilo-mcp', scope: 'uts:subjects.revoke' } },
      401,
      'invalid_client',
    ],
    [
      'an STS key set that does not answer',
      { status: 'unavailable' },
      503,
      'temporarily_unavailable',
    ],
  ])('refuses %s before any statement', async (_name, check, status, error) => {
    const grants = issuedStore();
    const callers: StsCallerVerifier = async () => check ?? caller;
    const response = await call(
      await exchangeRequest(await subjectToken(), {}, check === null ? null : 'Bearer sts.token'),
      grants,
      exchangeService({ callers })
    );
    expect(response.status).toBe(status);
    expect(await errorOf(response)).toBe(error);
    if (status === 401) expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
    if (status === 503) expect(response.headers.get('Retry-After')).not.toBeNull();
    expect(grants.calls).toEqual([]);
  });

  it.each<[string, Record<string, string>, string]>([
    [
      'another subject token type',
      { subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' },
      'invalid_request',
    ],
    [
      'another requested type',
      { requested_token_type: 'urn:ietf:params:oauth:token-type:jwt' },
      'invalid_request',
    ],
    [
      'an actor token',
      { actor_token: 'x', actor_token_type: UTS_ACCESS_TOKEN_TYPE_URN },
      'invalid_request',
    ],
    ['an audience parameter', { audience: 'kilo-api' }, 'invalid_request'],
    ['a scope only a grant mints', { scope: 'kilo-api:profile.read' }, 'invalid_scope'],
    ['an unregistered scope', { scope: 'kilo-api:admin.write' }, 'invalid_scope'],
    [
      'the subject scope itself',
      { scope: KILO_MCP_CATALOG_READ_SCOPE, resource: 'http://localhost:8815/mcp' },
      'invalid_scope',
    ],
    ['the urn resource', { resource: 'urn:kilo:service:kilo-api' }, 'invalid_target'],
    ['a resource with a path', { resource: `${API_ORIGIN}/api` }, 'invalid_target'],
    ['the production resource', { resource: 'https://app.kilo.ai' }, 'invalid_target'],
  ])('refuses %s with no statement', async (_name, fields, error) => {
    const grants = issuedStore();
    const response = await call(await exchangeRequest(await subjectToken(), fields), grants);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe(error);
    expect(grants.calls).toEqual([]);
  });

  it.each<[string, () => Promise<string>, string]>([
    [
      'a token under an unknown kid',
      async () => {
        const { privateKey } = await generateKeyPair('EdDSA');
        return await new SignJWT({ sub: ACCOUNT })
          .setProtectedHeader({
            alg: 'EdDSA',
            typ: 'at+jwt',
            kid: 'uts-token-01-' + 'A'.repeat(43),
          })
          .sign(privateKey);
      },
      'invalid_grant',
    ],
    [
      'a token of another audience',
      () =>
        subjectToken({ aud: 'kilo-api', scope: 'kilo-api:profile.read', client_id: 'kilo-cli' }),
      'invalid_scope',
    ],
    [
      'a delegated subject token',
      () => subjectToken({ act: { sub: 'kilo-mcp' } }),
      'invalid_grant',
    ],
    ['a token without sid', () => subjectToken({ sid: undefined }), 'invalid_grant'],
    [
      'a token of another issuer',
      () => subjectToken({ iss: 'https://uts.kiloapps.io' }),
      'invalid_grant',
    ],
    ['a token of another environment', () => subjectToken({ env: 'production' }), 'invalid_grant'],
    ['a token of an unknown client', () => subjectToken({ client_id: 'kilo-tv' }), 'invalid_grant'],
    [
      'a token of a client the scope does not allow',
      () => subjectToken({ client_id: 'kilo-web' }),
      'invalid_grant',
    ],
  ])('refuses %s before the store', async (_name, token, error) => {
    const grants = issuedStore();
    const response = await call(await exchangeRequest(await token()), grants);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe(error);
    expect(grants.calls).toEqual([]);
  });

  it('answers the store refusals: no consent is invalid_scope, an ended grant invalid_grant', async () => {
    for (const outcome of ['invalid_scope', 'invalid_grant'] as const) {
      const grants = fakeGrants({ exchangeDelegated: async () => ({ outcome }) });
      const response = await call(await exchangeRequest(await subjectToken()), grants);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(outcome);
      expect(grants.calls).toHaveLength(1);
    }
  });

  it('answers 503 with Retry-After when the store or the signer fails, and 500 when the store refuses the call', async () => {
    const failing = (failure: 'retryable' | 'permanent') =>
      fakeGrants({
        exchangeDelegated: async () => {
          throw storeFailure(failure);
        },
      });
    const retryable = await call(await exchangeRequest(await subjectToken()), failing('retryable'));
    expect(retryable.status).toBe(503);
    expect(retryable.headers.get('Retry-After')).toBe('2');
    const permanent = await call(await exchangeRequest(await subjectToken()), failing('permanent'));
    expect(permanent.status).toBe(500);
    const grants = issuedStore();
    const unsigned = await call(
      await exchangeRequest(await subjectToken()),
      grants,
      exchangeService(),
      async () => ({ status: 'unavailable' })
    );
    expect(unsigned.status).toBe(503);
    expect(unsigned.headers.get('Retry-After')).toBe('2');
    // The statement committed its audit row before the signer call failed.
    expect(grants.calls).toHaveLength(1);
  });

  it('answers 503 when the subject keys cannot be read', async () => {
    const grants = issuedStore();
    const response = await call(
      await exchangeRequest(await subjectToken()),
      grants,
      exchangeService({ keys: async () => ({ status: 'unavailable' }) })
    );
    expect(response.status).toBe(503);
    expect(grants.calls).toEqual([]);
  });

  it('limits a subject sid to 60 exchanges a minute: the 61st answers 429 slow_down with limit subject', async () => {
    let now = Date.parse('2026-11-26T12:00:00Z');
    const service = exchangeService({ now: () => now });
    const sid = crypto.randomUUID();
    const nowSeconds = () => Math.floor(now / 1000);
    const token = await subjectToken({ sid, iat: nowSeconds(), exp: nowSeconds() + 600 });
    const grants = issuedStore();
    // The real signer checks its clock, so the exchanges here use a fake signer.
    const sign: SignerAccess = async (_grant, claims) => ({
      status: 'signed',
      tokens: claims.map(() => 'signed.token.value'),
    });
    for (let index = 0; index < 60; index += 1) {
      expect((await call(await exchangeRequest(token), grants, service, sign)).status).toBe(200);
    }
    now += 20_000;
    const limited = await call(await exchangeRequest(token), grants, service, sign);
    expect(limited.status).toBe(429);
    expect(TokenExchangeSlowDownSchema.parse(await limited.json())).toEqual({
      error: 'slow_down',
      limit: 'subject',
    });
    expect(limited.headers.get('Retry-After')).toBe('40');
    expect(grants.calls).toHaveLength(60);
    // Another sid is not limited, and the window resets after a minute.
    const other = await subjectToken({ iat: nowSeconds(), exp: nowSeconds() + 600 });
    expect((await call(await exchangeRequest(other), grants, service, sign)).status).toBe(200);
    now += 40_000;
    expect((await call(await exchangeRequest(token), grants, service, sign)).status).toBe(200);
  });

  it('limits the calling workload to 600 exchanges a minute: the 601st answers 429 with limit caller', async () => {
    let now = Date.parse('2026-11-26T12:00:00Z');
    const service = exchangeService({ now: () => now });
    const grants = issuedStore();
    const sign: SignerAccess = async (_grant, claims) => ({
      status: 'signed',
      tokens: claims.map(() => 'signed.token.value'),
    });
    const nowSeconds = Math.floor(now / 1000);
    // Distinct sids, so only the caller limit applies.
    for (let index = 0; index < 600; index += 1) {
      const token = await subjectToken({ iat: nowSeconds, exp: nowSeconds + 600 });
      expect((await call(await exchangeRequest(token), grants, service, sign)).status).toBe(200);
    }
    now += 1_500;
    const token = await subjectToken({ iat: nowSeconds, exp: nowSeconds + 600 });
    const limited = await call(await exchangeRequest(token), grants, service, sign);
    expect(limited.status).toBe(429);
    expect(TokenExchangeSlowDownSchema.parse(await limited.json()).limit).toBe('caller');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get('Retry-After'))).toBeLessThanOrEqual(60);
    expect(grants.calls).toHaveLength(600);
  });

  it('is not offered without an STS token verifier', async () => {
    const response = await call(await exchangeRequest(await subjectToken()), issuedStore(), null);
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('unsupported_grant_type');
  });
});
