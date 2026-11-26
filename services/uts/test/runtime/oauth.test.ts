import { createExecutionContext } from 'cloudflare:test';
import {
  AuthorizationServerMetadataSchema,
  IntrospectionResponseSchema,
  TokenResponseSchema,
  UtsAccessTokenClaimsSchema,
  signerOfTokenKid,
} from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { handleDevRequest } from '../../src/dev';
import type { Env } from '../../src/env';
import type {
  ExchangeCodeInput,
  FirstPartyRefreshInput,
  IntrospectInput,
  IssueCodeInput,
} from '../../src/grants/store';
import { handleRequest } from '../../src/http';
import { signerForGrant } from '../../src/keys/signer-choice';
import type { AuthorizationHandoff, PendingAuthorization } from '../../src/oauth/authorize';
import { type OAuthDeps, handleOAuthRequest } from '../../src/oauth/routes';
import { s256Challenge } from '../../src/oauth/pkce';
import {
  createFirstPartyRefreshToken,
  grantIdOfCode,
  grantIdOfFirstPartyRefreshToken,
  randomCredential,
} from '../../src/token/credentials';
import { keySet } from './support';
import {
  INTROSPECT_URL,
  dpopKey,
  dpopProof,
  errorOf,
  fakeGrants,
  formRequest,
  minted,
  oauthDeps,
  storeFailure,
} from './oauth-support';
import { config, env } from './test-env';

const THIRD_PARTY = 'https://client.example.com/oauth/metadata.json';
const VERIFIER = randomCredential();

async function call(request: Request, deps: OAuthDeps) {
  const response = await handleOAuthRequest(request, new URL(request.url).pathname, deps);
  if (response === null) throw new Error('not an OAuth path');
  return response;
}

async function verifiedClaims(token: string, audience: string) {
  const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(await keySet()), {
    issuer: config.endpoints.issuer,
    audience,
    typ: 'at+jwt',
    algorithms: ['EdDSA'],
  });
  return { claims: UtsAccessTokenClaimsSchema.parse(payload), kid: protectedHeader.kid ?? '' };
}

describe('token endpoint: authorization_code', () => {
  it('exchanges a first-party code with a DPoP proof for a grant and signed tokens', async () => {
    const key = await dpopKey();
    const grants = fakeGrants({
      exchangeCode: async input => ({
        outcome: 'issued',
        refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        ...minted({
          tokenIds: [crypto.randomUUID(), crypto.randomUUID()],
          scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
        }),
        subjectId: `subject-of-${input.clientId}`,
      }),
    });
    const code = randomCredential();
    const response = await call(
      formRequest(
        '/token',
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://127.0.0.1:4100/callback',
          client_id: 'kilo-cli',
          code_verifier: VERIFIER,
          device_label: 'Work laptop',
        },
        { DPoP: await dpopProof(key), 'CF-Connecting-IP': '192.0.2.44' }
      ),
      oauthDeps(grants.access)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = TokenResponseSchema.parse(await response.json());

    const [{ input }] = grants.calls;
    const exchange = input as ExchangeCodeInput;
    expect(exchange.codeChallenge).toBe(await s256Challenge(VERIFIER));
    expect(exchange.binding).toMatchObject({
      kind: 'first_party',
      clientClass: 'desktop',
      device: { label: 'Work laptop', platform: 'unknown', clientIp: '192.0.2.44' },
    });
    if (exchange.binding.kind !== 'first_party') throw new Error('first-party binding expected');
    expect(Buffer.from(exchange.binding.proof.jkt)).toEqual(key.thumbprint);
    expect(exchange.grantId).toBe(await grantIdOfCode(code));
    expect(body.refresh_token).toMatch(/^kilo_rt_/);
    expect(body.refresh_token_expires_in).toBeGreaterThan(29 * 86_400);

    expect(body.issued_tokens.map(token => token.audience)).toEqual(['gateway', 'kilo-chat']);
    const { claims, kid } = await verifiedClaims(body.access_token, 'gateway');
    expect(Object.keys(claims).sort()).toEqual(
      [
        'amr',
        'aud',
        'auth_time',
        'client_id',
        'env',
        'exp',
        'iat',
        'iss',
        'jti',
        'scope',
        'sid',
        'sub',
      ].sort()
    );
    expect(claims).toMatchObject({
      sub: 'subject-of-kilo-cli',
      client_id: 'kilo-cli',
      sid: exchange.grantId,
      scope: 'gateway:models.read',
    });
    expect(claims.exp - claims.iat).toBe(600);
    expect(signerOfTokenKid(kid)).toBe(await signerForGrant(exchange.grantId));
  });

  it('needs a DPoP proof from a first-party client and refuses one from a third-party client', async () => {
    const grants = fakeGrants();
    const fields = {
      grant_type: 'authorization_code',
      code: randomCredential(),
      redirect_uri: 'http://127.0.0.1:4100/callback',
      client_id: 'kilo-cli',
      code_verifier: VERIFIER,
    };
    const missing = await call(formRequest('/token', fields), oauthDeps(grants.access));
    expect(missing.status).toBe(400);
    expect(missing.headers.get('WWW-Authenticate')).toBe(
      'DPoP error="invalid_dpop_proof", algs="EdDSA ES256"'
    );
    expect(await errorOf(missing)).toBe('invalid_dpop_proof');

    const thirdParty = await call(
      formRequest(
        '/token',
        { ...fields, client_id: THIRD_PARTY },
        { DPoP: await dpopProof(await dpopKey()) }
      ),
      oauthDeps(grants.access)
    );
    expect(await errorOf(thirdParty)).toBe('invalid_request');
    expect(grants.calls).toEqual([]);
  });

  it('maps each refused exchange to its OAuth error', async () => {
    for (const outcome of ['invalid_grant', 'invalid_scope', 'invalid_target'] as const) {
      const grants = fakeGrants({ exchangeCode: async () => ({ outcome }) });
      const response = await call(
        formRequest('/token', {
          grant_type: 'authorization_code',
          code: randomCredential(),
          redirect_uri: 'https://client.example.com/callback',
          client_id: THIRD_PARTY,
          code_verifier: VERIFIER,
        }),
        oauthDeps(grants.access)
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(outcome);
    }
  });

  it('answers a retry after a failed signing with the same grant and a new refresh token', async () => {
    const grants = fakeGrants({
      exchangeCode: async () => ({
        outcome: 'issued',
        refreshExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        ...minted(),
      }),
    });
    const key = await dpopKey();
    const code = randomCredential();
    const exchange = async () =>
      formRequest(
        '/token',
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: 'http://127.0.0.1:4100/callback',
          client_id: 'kilo-cli',
          code_verifier: VERIFIER,
        },
        { DPoP: await dpopProof(key) }
      );
    const failed = await call(
      await exchange(),
      oauthDeps(grants.access, { sign: async () => ({ status: 'unavailable' }) })
    );
    expect(failed.status).toBe(503);
    const retried = await call(await exchange(), oauthDeps(grants.access));
    expect(retried.status).toBe(200);
    const body = TokenResponseSchema.parse(await retried.json());

    const [first, second] = grants.calls.map(({ input }) => input as ExchangeCodeInput);
    expect(second.grantId).toBe(first.grantId);
    expect(first.grantId).toBe(await grantIdOfCode(code));
    expect(Buffer.from(second.refreshTokenHash)).not.toEqual(Buffer.from(first.refreshTokenHash));
    if (first.binding.kind !== 'first_party' || second.binding.kind !== 'first_party') {
      throw new Error('first-party bindings expected');
    }
    expect(second.binding.proof.jti).not.toBe(first.binding.proof.jti);
    expect(grantIdOfFirstPartyRefreshToken(body.refresh_token ?? '')).toBe(first.grantId);
    expect((await verifiedClaims(body.access_token, 'gateway')).claims.sid).toBe(first.grantId);
  });
});

describe('token endpoint: refresh_token', () => {
  const firstParty = async (key = Promise.resolve(dpopKey())) => {
    const grantId = crypto.randomUUID();
    return { grantId, token: createFirstPartyRefreshToken(grantId), key: await key };
  };

  it('mints from a DPoP-bound first-party grant without a new refresh token', async () => {
    const grant = await firstParty();
    const grants = fakeGrants({
      refreshFirstParty: async () => ({ outcome: 'issued', ...minted() }),
    });
    const response = await call(
      formRequest(
        '/token',
        {
          grant_type: 'refresh_token',
          refresh_token: grant.token,
          client_id: 'kilo-cli',
          scope: 'gateway:models.read',
        },
        { DPoP: await dpopProof(grant.key) }
      ),
      oauthDeps(grants.access)
    );
    expect(response.status).toBe(200);
    const body = TokenResponseSchema.parse(await response.json());
    expect(body.refresh_token).toBeUndefined();
    const input = grants.calls[0].input as FirstPartyRefreshInput;
    expect(input).toMatchObject({
      grantId: grant.grantId,
      scopes: ['gateway:models.read'],
      resources: null,
    });
    expect(Buffer.from(input.proof.jkt)).toEqual(grant.key.thumbprint);
    expect((await verifiedClaims(body.access_token, 'gateway')).claims.sid).toBe(grant.grantId);
  });

  it('passes the proof jti to the grant statement and refuses a proof it recorded before', async () => {
    const grant = await firstParty();
    const recorded = new Set<string>();
    const grants = fakeGrants({
      refreshFirstParty: async input => {
        if (recorded.has(input.proof.jti)) return { outcome: 'dpop_replay' };
        recorded.add(input.proof.jti);
        return { outcome: 'issued', ...minted() };
      },
    });
    const proof = await dpopProof(grant.key);
    const send = () =>
      call(
        formRequest(
          '/token',
          { grant_type: 'refresh_token', refresh_token: grant.token, client_id: 'kilo-cli' },
          { DPoP: proof }
        ),
        oauthDeps(grants.access)
      );
    expect((await send()).status).toBe(200);
    const replayed = await send();
    expect(replayed.status).toBe(400);
    expect(replayed.headers.get('WWW-Authenticate')).toMatch(/^DPoP error="invalid_dpop_proof"/);
    expect(await errorOf(replayed)).toBe('invalid_dpop_proof');
    expect([...recorded]).toEqual([decodeJwt(proof).jti]);
  });

  it('answers invalid_grant for a key mismatch, reuse and a malformed token', async () => {
    const grant = await firstParty();
    const mismatch = fakeGrants({ refreshFirstParty: async () => ({ outcome: 'dpop_mismatch' }) });
    const mismatched = await call(
      formRequest(
        '/token',
        { grant_type: 'refresh_token', refresh_token: grant.token, client_id: 'kilo-cli' },
        { DPoP: await dpopProof(grant.key) }
      ),
      oauthDeps(mismatch.access)
    );
    expect(await errorOf(mismatched)).toBe('invalid_grant');

    const reuse = fakeGrants({ refreshThirdParty: async () => ({ outcome: 'reuse_detected' }) });
    const reused = await call(
      formRequest('/token', {
        grant_type: 'refresh_token',
        refresh_token: randomCredential(),
        client_id: THIRD_PARTY,
      }),
      oauthDeps(reuse.access)
    );
    expect(await errorOf(reused)).toBe('invalid_grant');

    const none = fakeGrants();
    const malformed = await call(
      formRequest('/token', {
        grant_type: 'refresh_token',
        refresh_token: 'kilo_rt_short',
        client_id: 'kilo-cli',
      }),
      oauthDeps(none.access)
    );
    expect(await errorOf(malformed)).toBe('invalid_grant');
    expect(none.calls).toEqual([]);
  });

  it('rotates a third-party refresh token', async () => {
    const presented = randomCredential();
    const familyId = crypto.randomUUID();
    const grants = fakeGrants({
      refreshThirdParty: async () => ({
        outcome: 'issued',
        familyId,
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
        ...minted({ scopes: ['mcp:tools.read'] }),
      }),
    });
    const response = await call(
      formRequest('/token', {
        grant_type: 'refresh_token',
        refresh_token: presented,
        client_id: THIRD_PARTY,
      }),
      oauthDeps(grants.access)
    );
    const body = TokenResponseSchema.parse(await response.json());
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).not.toBe(presented);
    const { claims } = await verifiedClaims(body.access_token, 'mcp');
    expect(claims).toMatchObject({ sid: familyId, client_id: THIRD_PARTY });
  });

  it('answers 503 for a retryable store failure or a signer that does not answer', async () => {
    const failing = fakeGrants({
      refreshThirdParty: async () => {
        throw storeFailure('retryable');
      },
    });
    const thirdParty = () =>
      formRequest('/token', {
        grant_type: 'refresh_token',
        refresh_token: randomCredential(),
        client_id: THIRD_PARTY,
      });
    const stored = await call(thirdParty(), oauthDeps(failing.access));
    expect(stored.status).toBe(503);
    expect(stored.headers.get('Retry-After')).toBe('2');
    expect(await errorOf(stored)).toBe('temporarily_unavailable');

    const issued = fakeGrants({
      refreshThirdParty: async () => ({
        outcome: 'issued',
        familyId: crypto.randomUUID(),
        refreshExpiresAt: new Date(Date.now() + 1000),
        ...minted(),
      }),
    });
    const unsigned = await call(
      thirdParty(),
      oauthDeps(issued.access, { sign: async () => ({ status: 'unavailable' }) })
    );
    expect(unsigned.status).toBe(503);
  });

  it('answers 500 for a permanent store failure and a misconfigured signer', async () => {
    const thirdParty = () =>
      formRequest('/token', {
        grant_type: 'refresh_token',
        refresh_token: randomCredential(),
        client_id: THIRD_PARTY,
      });
    const failing = fakeGrants({
      refreshThirdParty: async () => {
        throw storeFailure('permanent');
      },
    });
    expect((await call(thirdParty(), oauthDeps(failing.access))).status).toBe(500);
    const issued = fakeGrants({
      refreshThirdParty: async () => ({
        outcome: 'issued',
        familyId: crypto.randomUUID(),
        refreshExpiresAt: new Date(Date.now() + 1000),
        ...minted(),
      }),
    });
    const refused = await call(
      thirdParty(),
      oauthDeps(issued.access, { sign: async () => ({ status: 'misconfigured' }) })
    );
    expect(refused.status).toBe(500);
    expect(await errorOf(refused)).toBe('server_error');
  });
});

describe('token endpoint: request shape', () => {
  it.each([
    ['no grant type', {}, 'invalid_request'],
    ['client credentials', { grant_type: 'client_credentials' }, 'unsupported_grant_type'],
    [
      'the device grant without its hook',
      { grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
      'unsupported_grant_type',
    ],
    [
      'an unknown client',
      { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nobody' },
      'invalid_client',
    ],
    [
      'more than 8 scopes',
      {
        grant_type: 'refresh_token',
        refresh_token: 'x',
        client_id: THIRD_PARTY,
        scope: Array.from({ length: 9 }, (_, i) => `gateway:p${i}`).join(' '),
      },
      'invalid_scope',
    ],
    [
      'a resource without a scope',
      {
        grant_type: 'refresh_token',
        refresh_token: 'x',
        client_id: THIRD_PARTY,
        scope: 'gateway:models.read',
        resource: ['urn:kilo:service:gateway', 'urn:kilo:service:mcp'],
      },
      'invalid_target',
    ],
  ])('refuses %s', async (_name, fields: Record<string, string | string[]>, error) => {
    const grants = fakeGrants();
    const response = await call(formRequest('/token', fields), oauthDeps(grants.access));
    expect(await errorOf(response)).toBe(error);
    expect(grants.calls).toEqual([]);
  });

  it('hands the device grant to its hook when one is wired', async () => {
    const response = await call(
      formRequest('/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      oauthDeps(fakeGrants().access, {
        deviceCodeGrant: async () => new Response('hook', { status: 418 }),
      })
    );
    expect(response.status).toBe(418);
  });

  it('refuses a JSON body and another method', async () => {
    const json = new Request(`${config.endpoints.issuer}/token`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await errorOf(await call(json, oauthDeps(fakeGrants().access)))).toBe('invalid_request');
    const get = await call(
      new Request(`${config.endpoints.issuer}/token`),
      oauthDeps(fakeGrants().access)
    );
    expect(get.status).toBe(405);
  });
});

describe('authorization endpoint', () => {
  const jkt = Buffer.alloc(32, 7).toString('base64url');
  const authorizeUrl = (params: Record<string, string | string[]>) => {
    const url = new URL(`${config.endpoints.issuer}/authorize`);
    for (const [name, value] of Object.entries(params)) {
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(name, item);
    }
    return new Request(url);
  };
  const base = {
    response_type: 'code',
    client_id: 'kilo-cli',
    redirect_uri: 'http://127.0.0.1:4100/callback',
    code_challenge: Buffer.alloc(32, 1).toString('base64url'),
    code_challenge_method: 'S256',
    scope: 'kilo-chat:messages.read gateway:models.read',
    state: 'state-1',
    dpop_jkt: jkt,
  };
  const approve: AuthorizationHandoff = async (_request, pending) =>
    pending.client.kind === 'first_party'
      ? {
          status: 'approved',
          approval: {
            accountId: 'oauth/user',
            browserSessionId: null,
            authTime: new Date(),
            amr: ['passkey'],
            orgId: null,
            clientKind: 'first_party',
          },
        }
      : {
          status: 'approved',
          approval: {
            accountId: 'oauth/user',
            browserSessionId: null,
            authTime: new Date(),
            amr: ['oauth'],
            orgId: null,
            clientKind: 'third_party',
            consentId: crypto.randomUUID(),
          },
        };
  const redirectOf = (response: Response) =>
    new URL(response.headers.get('Location') ?? 'about:blank');

  it('issues a code bound to the DPoP key and returns it with state and iss', async () => {
    let pending: PendingAuthorization | undefined;
    const grants = fakeGrants({ issueCode: async () => 'issued' });
    const response = await call(
      authorizeUrl({
        ...base,
        resource: ['urn:kilo:service:gateway', 'urn:kilo:service:kilo-chat'],
      }),
      oauthDeps(grants.access, {
        handoff: async (request, next) => {
          pending = next;
          return await approve(request, next);
        },
      })
    );
    expect(response.status).toBe(302);
    const location = redirectOf(response);
    expect(`${location.origin}${location.pathname}`).toBe('http://127.0.0.1:4100/callback');
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('state')).toBe('state-1');
    expect(location.searchParams.get('iss')).toBe(config.endpoints.issuer);
    expect(pending).toMatchObject({
      scopes: ['gateway:models.read', 'kilo-chat:messages.read'],
      audiences: ['gateway', 'kilo-chat'],
      client: { kind: 'first_party', clientClass: 'desktop' },
    });
    const issued = grants.calls[0].input as IssueCodeInput;
    expect(issued.client).toEqual({
      kind: 'first_party',
      clientId: 'kilo-cli',
      dpopJkt: Buffer.from(jkt, 'base64url'),
    });
    expect(issued.codeChallenge).toBe(base.code_challenge);
  });

  it('shows an error without redirecting for a bad client or redirect URI', async () => {
    const deps = oauthDeps(fakeGrants({ findThirdPartyClient: async () => null }).access, {
      handoff: approve,
    });
    // An empty parameter counts as absent (RFC 6749 section 3.1).
    for (const [params, status, error] of [
      [{ ...base, client_id: 'nobody' }, 401, 'invalid_client'],
      [{ ...base, redirect_uri: 'http://localhost:4100/callback' }, 400, 'invalid_request'],
      [{ ...base, redirect_uri: '' }, 400, 'invalid_request'],
      [{ ...base, client_id: THIRD_PARTY }, 401, 'invalid_client'],
    ] as const) {
      const response = await call(authorizeUrl(params), deps);
      expect(response.headers.get('Location')).toBeNull();
      expect(response.status).toBe(status);
      expect(await errorOf(response)).toBe(error);
    }
  });

  it.each([
    ['another response type', { response_type: 'token' }, 'unsupported_response_type'],
    ['a plain PKCE method', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['no scope', { scope: '' }, 'invalid_scope'],
    ['a resource no scope belongs to', { resource: 'urn:kilo:service:mcp' }, 'invalid_target'],
    ['no DPoP key for a first-party client', { dpop_jkt: '' }, 'invalid_request'],
    ['a repeated state', { state: ['a', 'b'] }, 'invalid_request'],
  ])(
    'redirects %s back with its error',
    async (_name, change: Record<string, string | string[]>, error) => {
      const grants = fakeGrants();
      const response = await call(
        authorizeUrl({ ...base, ...change }),
        oauthDeps(grants.access, { handoff: approve })
      );
      expect(response.status).toBe(302);
      const location = redirectOf(response);
      expect(location.searchParams.get('error')).toBe(error);
      expect(location.searchParams.get('iss')).toBe(config.endpoints.issuer);
      expect(grants.calls).toEqual([]);
    }
  );

  it('redirects a denial, passes an interaction through, and maps store outcomes', async () => {
    const denied = await call(
      authorizeUrl(base),
      oauthDeps(fakeGrants().access, { handoff: async () => ({ status: 'denied' }) })
    );
    expect(redirectOf(denied).searchParams.get('error')).toBe('access_denied');
    expect(redirectOf(denied).searchParams.get('state')).toBe('state-1');

    const page = new Response('sign in', { status: 200 });
    const interaction = await call(
      authorizeUrl(base),
      oauthDeps(fakeGrants().access, {
        handoff: async () => ({ status: 'interaction', response: page }),
      })
    );
    expect(await interaction.text()).toBe('sign in');

    const blocked = await call(
      authorizeUrl(base),
      oauthDeps(fakeGrants({ issueCode: async () => 'access_denied' }).access, { handoff: approve })
    );
    expect(redirectOf(blocked).searchParams.get('error')).toBe('access_denied');

    const unavailable = await call(
      authorizeUrl(base),
      oauthDeps(
        fakeGrants({
          issueCode: async () => {
            throw storeFailure('retryable');
          },
        }).access,
        { handoff: approve }
      )
    );
    expect(redirectOf(unavailable).searchParams.get('error')).toBe('temporarily_unavailable');
    const broken = await call(
      authorizeUrl(base),
      oauthDeps(
        fakeGrants({
          issueCode: async () => {
            throw storeFailure('permanent');
          },
        }).access,
        { handoff: approve }
      )
    );
    expect(redirectOf(broken).searchParams.get('error')).toBe('server_error');
  });

  it('authorizes a third-party client from its cached metadata with the consent the hand-off names', async () => {
    const grants = fakeGrants({
      findThirdPartyClient: async clientId => ({
        clientId,
        name: 'Example',
        redirectUris: ['https://client.example.com/callback'],
      }),
      issueCode: async () => 'issued',
    });
    const response = await call(
      authorizeUrl({
        ...base,
        client_id: THIRD_PARTY,
        redirect_uri: 'https://client.example.com/callback',
        dpop_jkt: '',
      }),
      oauthDeps(grants.access, { handoff: approve })
    );
    expect(redirectOf(response).searchParams.get('code')).not.toBeNull();
    expect((grants.calls[1].input as IssueCodeInput).client).toMatchObject({
      kind: 'third_party',
      clientId: THIRD_PARTY,
    });

    const lookupFailure = await call(
      authorizeUrl({
        ...base,
        client_id: THIRD_PARTY,
        redirect_uri: 'https://client.example.com/callback',
      }),
      oauthDeps(
        fakeGrants({
          findThirdPartyClient: async () => {
            throw storeFailure('retryable');
          },
        }).access,
        { handoff: approve }
      )
    );
    expect(lookupFailure.status).toBe(503);
    expect(lookupFailure.headers.get('Location')).toBeNull();
  });
});

describe('revocation endpoint', () => {
  it('revokes a refresh token and answers 200 for unknown and malformed tokens', async () => {
    const grants = fakeGrants({ revoke: async () => 'revoked' });
    const token = createFirstPartyRefreshToken(crypto.randomUUID());
    const revoked = await call(
      formRequest('/revoke', { token, client_id: 'kilo-cli' }),
      oauthDeps(grants.access)
    );
    expect(revoked.status).toBe(200);
    expect(grants.calls).toHaveLength(1);

    const unknown = fakeGrants({ revoke: async () => 'unknown' });
    expect(
      (
        await call(
          formRequest('/revoke', { token, client_id: 'kilo-cli' }),
          oauthDeps(unknown.access)
        )
      ).status
    ).toBe(200);
    const none = fakeGrants();
    expect(
      (
        await call(
          formRequest('/revoke', { token: 'nonsense', client_id: 'kilo-cli' }),
          oauthDeps(none.access)
        )
      ).status
    ).toBe(200);
    expect(none.calls).toEqual([]);
  });

  it('refuses an access token and an unknown client', async () => {
    // A compact JWS shape; the endpoint refuses it before any lookup.
    const jwt = ['eyJhbGciOiJFZERTQSJ9', 'eyJzdWIiOiJ4In0', 'c2ln'].join('.');
    expect(
      await errorOf(
        await call(
          formRequest('/revoke', { token: jwt, client_id: 'kilo-cli' }),
          oauthDeps(fakeGrants().access)
        )
      )
    ).toBe('unsupported_token_type');
    const unknown = await call(
      formRequest('/revoke', { token: randomCredential(), client_id: 'nobody' }),
      oauthDeps(fakeGrants().access)
    );
    expect(unknown.status).toBe(401);
  });

  it('answers a token of another client like an unknown token', async () => {
    const answer = async (outcome: 'client_mismatch' | 'unknown') => {
      const grants = fakeGrants({ revoke: async () => outcome });
      const response = await call(
        formRequest('/revoke', { token: randomCredential(), client_id: THIRD_PARTY }),
        oauthDeps(grants.access)
      );
      expect(grants.calls).toHaveLength(1);
      return { status: response.status, body: await response.text() };
    };
    expect(await answer('client_mismatch')).toEqual(await answer('unknown'));
    expect(await answer('client_mismatch')).toEqual({ status: 200, body: '' });
  });

  it('answers 503 and 500 for store failures', async () => {
    for (const [failure, status] of [
      ['retryable', 503],
      ['permanent', 500],
    ] as const) {
      const grants = fakeGrants({
        revoke: async () => {
          throw storeFailure(failure);
        },
      });
      const response = await call(
        formRequest('/revoke', { token: randomCredential(), client_id: THIRD_PARTY }),
        oauthDeps(grants.access)
      );
      expect(response.status).toBe(status);
    }
  });
});

describe('introspection endpoint', () => {
  const active = {
    grantId: crypto.randomUUID(),
    subjectId: 'oauth/user',
    scopes: ['gateway:models.read', 'mcp:tools.read'],
    issuedAt: new Date(1_800_000_000_000),
    expiresAt: new Date(1_802_592_000_000),
  };

  it('answers an active first-party grant to its own client with a DPoP proof', async () => {
    const key = await dpopKey();
    const grants = fakeGrants({
      introspect: async () => ({ outcome: 'active', kind: 'first_party', ...active }),
    });
    const token = createFirstPartyRefreshToken(active.grantId);
    const proof = await dpopProof(key, INTROSPECT_URL);
    const response = await call(
      formRequest('/introspect', { token, client_id: 'kilo-cli' }, { DPoP: proof }),
      oauthDeps(grants.access)
    );
    expect(IntrospectionResponseSchema.parse(await response.json())).toEqual({
      active: true,
      token_type: 'refresh_token',
      client_id: 'kilo-cli',
      sub: 'oauth/user',
      scope: 'gateway:models.read mcp:tools.read',
      iat: 1_800_000_000,
      exp: 1_802_592_000,
      iss: config.endpoints.issuer,
      sid: active.grantId,
    });
    const input = grants.calls[0].input as IntrospectInput;
    expect(input.proof?.jti).toBe(decodeJwt(proof).jti);
    expect(Buffer.from(input.proof?.jkt ?? [])).toEqual(key.thumbprint);
  });

  it('refuses a first-party proof the statement recorded before', async () => {
    const grants = fakeGrants({ introspect: async () => ({ outcome: 'dpop_replay' }) });
    const response = await call(
      formRequest(
        '/introspect',
        { token: createFirstPartyRefreshToken(active.grantId), client_id: 'kilo-cli' },
        { DPoP: await dpopProof(await dpopKey(), INTROSPECT_URL) }
      ),
      oauthDeps(grants.access)
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_dpop_proof');
  });

  it('needs the proof for the introspection URL from a first-party client', async () => {
    const token = createFirstPartyRefreshToken(active.grantId);
    const wrongUrl = await call(
      formRequest(
        '/introspect',
        { token, client_id: 'kilo-cli' },
        { DPoP: await dpopProof(await dpopKey()) }
      ),
      oauthDeps(fakeGrants().access)
    );
    expect(await errorOf(wrongUrl)).toBe('invalid_dpop_proof');
  });

  it('answers inactive for an access token, an unknown token and a foreign one', async () => {
    const none = fakeGrants({ introspect: async () => ({ outcome: 'inactive' }) });
    const inactive = async (token: string, clientId = THIRD_PARTY) =>
      (
        await call(
          formRequest('/introspect', { token, client_id: clientId }),
          oauthDeps(none.access)
        )
      ).json();
    const jwt = ['eyJhbGciOiJFZERTQSJ9', 'eyJzdWIiOiJ4In0', 'c2ln'].join('.');
    expect(await inactive(jwt)).toEqual({ active: false });
    expect(await inactive(randomCredential())).toEqual({ active: false });
    expect(await inactive(randomCredential(), 'kilo-cli')).toEqual({ active: false });
    expect(none.calls).toHaveLength(1);
  });

  it('refuses a request without a known client and answers 503 for a store failure', async () => {
    expect(
      (
        await call(
          formRequest('/introspect', { token: randomCredential() }),
          oauthDeps(fakeGrants().access)
        )
      ).status
    ).toBe(400);
    expect(
      (
        await call(
          formRequest('/introspect', { token: randomCredential(), client_id: 'nobody' }),
          oauthDeps(fakeGrants().access)
        )
      ).status
    ).toBe(401);
    const failing = fakeGrants({
      introspect: async () => {
        throw storeFailure('retryable');
      },
    });
    expect(
      (
        await call(
          formRequest('/introspect', { token: randomCredential(), client_id: THIRD_PARTY }),
          oauthDeps(failing.access)
        )
      ).status
    ).toBe(503);
  });
});

describe('mint Worker wiring', () => {
  const unprovisioned: Env = { ...env, IDENTITY_STORE: undefined };
  const fetchMint = (request: Request, target: Env = env) =>
    handleRequest(request, target, createExecutionContext());
  const metadata = async (response: Response) =>
    AuthorizationServerMetadataSchema.parse(await response.json());
  const metadataRequest = () =>
    new Request(`${config.endpoints.issuer}/.well-known/oauth-authorization-server`);

  it('serves no OAuth endpoint while the identity store is unbound', async () => {
    expect(
      (await fetchMint(formRequest('/token', { grant_type: 'refresh_token' }), unprovisioned))
        .status
    ).toBe(404);
    expect(await metadata(await fetchMint(metadataRequest(), unprovisioned))).toEqual({
      issuer: config.endpoints.issuer,
      jwks_uri: config.endpoints.jwksUri,
      response_types_supported: [],
      grant_types_supported: [],
    });
  });

  it('lists the token, revocation and introspection endpoints once the store is bound, and the authorization endpoint only with a hand-off', async () => {
    const deployed = await metadata(await fetchMint(metadataRequest()));
    expect(deployed).toMatchObject({
      token_endpoint: `${config.endpoints.issuer}/token`,
      revocation_endpoint: `${config.endpoints.issuer}/revoke`,
      introspection_endpoint: `${config.endpoints.issuer}/introspect`,
      grant_types_supported: ['refresh_token'],
      response_types_supported: [],
      code_challenge_methods_supported: ['S256'],
      dpop_signing_alg_values_supported: ['EdDSA', 'ES256'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(deployed.authorization_endpoint).toBeUndefined();
    expect((await fetchMint(new Request(`${config.endpoints.issuer}/authorize`))).status).toBe(404);

    const development = await metadata(
      await handleDevRequest(metadataRequest(), env, createExecutionContext())
    );
    expect(development).toMatchObject({
      authorization_endpoint: `${config.endpoints.issuer}/authorize`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });
});
