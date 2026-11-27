import { createExecutionContext } from 'cloudflare:test';
import {
  AuthorizationServerMetadataSchema,
  IntrospectionResponseSchema,
  TokenResponseSchema,
  UtsAccessTokenClaimsSchema,
  type UtsOrgRole,
  signerOfTokenKid,
} from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
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
import type { ThirdPartyClients } from '../../src/third-party/clients';
import {
  firstPartyRefreshToken,
  firstPartyRefreshTokenOfExchange,
  grantIdOfCode,
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
  grantEntry,
  recordingPublisher,
  unexpectedStore,
  storeFailure,
} from './oauth-support';
import { config, env, noSignInMethods } from './test-env';

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

  it('maps each refused exchange to its OAuth error and publishes what its statement revoked', async () => {
    for (const outcome of ['invalid_grant', 'invalid_scope', 'invalid_target'] as const) {
      const revoked = outcome === 'invalid_grant' ? [grantEntry()] : [];
      const grants = fakeGrants({ exchangeCode: async () => ({ outcome, feedEntries: revoked }) });
      const feed = recordingPublisher();
      const response = await call(
        formRequest('/token', {
          grant_type: 'authorization_code',
          code: randomCredential(),
          redirect_uri: 'https://client.example.com/callback',
          client_id: THIRD_PARTY,
          code_verifier: VERIFIER,
        }),
        oauthDeps(grants.access, { publish: feed.publish })
      );
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toBe(outcome);
      expect(feed.batches).toEqual([revoked]);
    }
  });

  it('answers a retry after a failed signing with the same grant and the same refresh token', async () => {
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
    // The refresh token derives from the code and the verifier, so every attempt sends one hash.
    expect(Buffer.from(second.refreshTokenHash)).toEqual(Buffer.from(first.refreshTokenHash));
    if (first.binding.kind !== 'first_party' || second.binding.kind !== 'first_party') {
      throw new Error('first-party bindings expected');
    }
    expect(second.binding.proof.jti).not.toBe(first.binding.proof.jti);
    expect(body.refresh_token).toBe(
      await firstPartyRefreshTokenOfExchange(first.grantId, code, VERIFIER)
    );
    expect((await verifiedClaims(body.access_token, 'gateway')).claims.sid).toBe(first.grantId);
  });
});

describe('token endpoint: refresh_token', () => {
  const firstParty = async (key = Promise.resolve(dpopKey())) => {
    const grantId = crypto.randomUUID();
    return { grantId, token: firstPartyRefreshToken(grantId, randomCredential()), key: await key };
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

  it('signs a token for a role-limited organization scope only for an allowed role in the org', async () => {
    const request = async (orgId: string | null, orgRole: UtsOrgRole | null) => {
      const grant = await firstParty();
      const grants = fakeGrants({
        refreshFirstParty: async () => ({
          outcome: 'issued',
          ...minted({ scopes: ['ai-attribution:identity.read'], orgId, orgRole }),
        }),
      });
      return await call(
        formRequest(
          '/token',
          {
            grant_type: 'refresh_token',
            refresh_token: grant.token,
            client_id: 'kilo-cli',
            scope: 'ai-attribution:identity.read',
          },
          { DPoP: await dpopProof(grant.key) }
        ),
        oauthDeps(grants.access)
      );
    };
    const org = crypto.randomUUID();
    for (const [orgId, role] of [
      [null, null],
      [org, 'admin'],
      [org, 'billing_manager'],
      [org, null],
    ] as const) {
      const refused = await request(orgId, role);
      expect(refused.status).toBe(400);
      expect(await errorOf(refused)).toBe('invalid_grant');
    }

    for (const role of ['owner', 'member'] as const) {
      const signed = await request(org, role);
      expect(signed.status).toBe(200);
      const body = TokenResponseSchema.parse(await signed.json());
      expect((await verifiedClaims(body.access_token, 'ai-attribution')).claims.org).toBe(org);
    }
  });

  it.each([
    ['kilo-cli', 'user-data-export:exports.dispatch'],
    ['kilo-cli', 'gateway:unknown.read'],
    [THIRD_PARTY, 'kilo-api:profile.read'],
    [THIRD_PARTY, 'ai-attribution:identity.read'],
  ])(
    'refuses %s a requested scope it may not hold before the statement, and a minted one before signing',
    async (clientId, scope) => {
      const firstPartyClient = clientId === 'kilo-cli';
      const request = async (form: Record<string, string>) => {
        const grant = await firstParty();
        const body = {
          grant_type: 'refresh_token',
          refresh_token: firstPartyClient ? grant.token : randomCredential(),
          client_id: clientId,
          ...form,
        };
        return firstPartyClient
          ? formRequest('/token', body, { DPoP: await dpopProof(grant.key) })
          : formRequest('/token', body);
      };
      const issued = {
        outcome: 'issued',
        familyId: crypto.randomUUID(),
        refreshExpiresAt: new Date(Date.now() + 86_400_000),
        ...minted({ scopes: [scope] }),
      } as const;

      const named = fakeGrants({
        refreshFirstParty: async () => issued,
        refreshThirdParty: async () => issued,
      });
      const before = await call(await request({ scope }), oauthDeps(named.access));
      expect(before.status).toBe(400);
      expect(await errorOf(before)).toBe('invalid_scope');
      expect(named.calls).toEqual([]);

      // A grant that holds such a scope (the registry changed after it was created) signs nothing.
      const stored = fakeGrants({
        refreshFirstParty: async () => issued,
        refreshThirdParty: async () => issued,
      });
      let signed = false;
      const after = await call(
        await request({}),
        oauthDeps(stored.access, {
          sign: async () => {
            signed = true;
            return { status: 'unavailable' };
          },
        })
      );
      expect(after.status).toBe(400);
      expect(await errorOf(after)).toBe('invalid_scope');
      expect(stored.calls).toHaveLength(1);
      expect(signed).toBe(false);
    }
  );

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

    const family = grantEntry();
    const reuse = fakeGrants({
      refreshThirdParty: async () => ({ outcome: 'reuse_detected', feedEntries: [family] }),
    });
    for (const outcome of ['published', 'unpublished'] as const) {
      const feed = recordingPublisher(outcome);
      const reused = await call(
        formRequest('/token', {
          grant_type: 'refresh_token',
          refresh_token: randomCredential(),
          client_id: THIRD_PARTY,
        }),
        oauthDeps(reuse.access, { publish: feed.publish })
      );
      // A failed publish changes nothing in the answer; the backfill adds the entry.
      expect(await errorOf(reused)).toBe('invalid_grant');
      expect(feed.batches).toEqual([[family]]);
    }

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
        device: {
          grant: async () => new Response('hook', { status: 418 }),
          pages: {
            config,
            signIn: unexpectedStore,
            methods: noSignInMethods,
            userCodeSecret: 'A'.repeat(43),
          },
        },
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
    const grants = fakeGrants({ issueCode: async () => ({ outcome: 'issued', orgRole: null }) });
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
    const deps = oauthDeps(fakeGrants().access, {
      handoff: approve,
      clients: async () => ({ kind: 'refused', reason: 'document missing' }),
    });
    // An empty parameter counts as absent (RFC 6749 section 3.1).
    for (const [params, status, error] of [
      [{ ...base, client_id: 'nobody' }, 401, 'invalid_client'],
      [{ ...base, redirect_uri: 'http://localhost:4100/callback' }, 400, 'invalid_request'],
      [{ ...base, redirect_uri: 'http://[::1]:4100/callback' }, 400, 'invalid_request'],
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
    [
      'nine scopes, so nine audiences',
      { scope: Array.from({ length: 9 }, (_, index) => `service${index}:read`).join(' ') },
      'invalid_scope',
    ],
    [
      'nine resources',
      {
        scope: 'gateway:models.read',
        resource: Array.from({ length: 9 }, (_, index) => `urn:kilo:service:service${index}`),
      },
      'invalid_target',
    ],
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
      oauthDeps(fakeGrants({ issueCode: async () => ({ outcome: 'access_denied' }) }).access, {
        handoff: approve,
      })
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

  it('refuses an organization scope without an organization or with a role outside its roles', async () => {
    const issuedAs = (orgRole: UtsOrgRole | null) => async () =>
      ({ outcome: 'issued', orgRole }) as const;
    const scoped = { ...base, scope: 'ai-attribution:identity.read' };
    const without = fakeGrants({ issueCode: issuedAs(null) });
    const refused = await call(
      authorizeUrl(scoped),
      oauthDeps(without.access, { handoff: approve })
    );
    expect(redirectOf(refused).searchParams.get('error')).toBe('invalid_scope');
    expect(without.calls).toEqual([]);

    const org = crypto.randomUUID();
    const inOrg: AuthorizationHandoff = async (request, next) => {
      const decision = await approve(request, next);
      return decision.status === 'approved'
        ? { ...decision, approval: { ...decision.approval, orgId: org } }
        : decision;
    };
    // The code statement refuses a role outside the scope's roles itself (migration 0005), and
    // the endpoint hands out nothing.
    const roleRefused = fakeGrants({ issueCode: async () => ({ outcome: 'invalid_scope' }) });
    const admin = await call(
      authorizeUrl(scoped),
      oauthDeps(roleRefused.access, { handoff: inOrg })
    );
    expect(redirectOf(admin).searchParams.get('error')).toBe('invalid_scope');
    expect(redirectOf(admin).searchParams.get('code')).toBeNull();
    expect(roleRefused.calls.map(item => item.method)).toEqual(['issueCode']);

    for (const role of ['owner', 'member'] as const) {
      const withOrg = fakeGrants({ issueCode: issuedAs(role) });
      const issued = await call(
        authorizeUrl(scoped),
        oauthDeps(withOrg.access, { handoff: inOrg })
      );
      expect(redirectOf(issued).searchParams.get('code')).not.toBeNull();
      expect((withOrg.calls[0].input as IssueCodeInput).orgId).toBe(org);
    }
  });

  /** A third-party client whose metadata names one redirect URI. */
  const knownClient: ThirdPartyClients = async clientId => ({
    kind: 'client',
    client: { clientId, name: 'Example', redirectUris: ['https://client.example.com/callback'] },
  });

  it('authorizes a third-party client from its metadata with the consent the hand-off names', async () => {
    const grants = fakeGrants({
      issueCode: async () => ({ outcome: 'issued', orgRole: null }),
    });
    const response = await call(
      authorizeUrl({
        ...base,
        client_id: THIRD_PARTY,
        redirect_uri: 'https://client.example.com/callback',
        dpop_jkt: '',
      }),
      oauthDeps(grants.access, { handoff: approve, clients: knownClient })
    );
    expect(redirectOf(response).searchParams.get('code')).not.toBeNull();
    expect((grants.calls[0].input as IssueCodeInput).client).toMatchObject({
      kind: 'third_party',
      clientId: THIRD_PARTY,
    });

    const lookupFailure = await call(
      authorizeUrl({
        ...base,
        client_id: THIRD_PARTY,
        redirect_uri: 'https://client.example.com/callback',
      }),
      oauthDeps(fakeGrants().access, {
        handoff: approve,
        clients: async () => ({ kind: 'unavailable' }),
      })
    );
    expect(lookupFailure.status).toBe(503);
    expect(lookupFailure.headers.get('Retry-After')).not.toBeNull();
    expect(lookupFailure.headers.get('Location')).toBeNull();
  });

  it.each([
    ['an unsupported response type', { response_type: 'token' }, 'unsupported_response_type'],
    ['no PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['a repeated state', { state: ['one', 'two'] }, 'invalid_request'],
    ['an unknown scope', { scope: 'gateway:unknown.read' }, 'invalid_scope'],
    ['a DPoP key', { dpop_jkt: jkt }, 'invalid_request'],
  ])(
    'shows a third-party error before the hand-off for %s, never a redirect to the URI its own document lists',
    async (_name, change, error) => {
      let handedOff = false;
      const response = await call(
        authorizeUrl({
          ...base,
          client_id: THIRD_PARTY,
          redirect_uri: 'https://client.example.com/callback',
          dpop_jkt: '',
          ...change,
        }),
        oauthDeps(fakeGrants().access, {
          clients: knownClient,
          handoff: async () => {
            handedOff = true;
            return { status: 'denied' };
          },
        })
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('Location')).toBeNull();
      expect(await errorOf(response)).toBe(error);
      expect(handedOff).toBe(false);
    }
  );

  it('redirects a third-party denial once the user acted in the hand-off', async () => {
    const response = await call(
      authorizeUrl({
        ...base,
        client_id: THIRD_PARTY,
        redirect_uri: 'https://client.example.com/callback',
        dpop_jkt: '',
      }),
      oauthDeps(fakeGrants().access, {
        clients: knownClient,
        handoff: async () => ({ status: 'denied' }),
      })
    );
    expect(response.status).toBe(302);
    expect(redirectOf(response).origin).toBe('https://client.example.com');
    expect(redirectOf(response).searchParams.get('error')).toBe('access_denied');
  });

  it('refuses a cached redirect URI that is not a reverse-domain private-use scheme', async () => {
    const response = await call(
      authorizeUrl({
        ...base,
        client_id: THIRD_PARTY,
        redirect_uri: 'myapp:/callback',
        dpop_jkt: '',
      }),
      oauthDeps(fakeGrants().access, {
        clients: async clientId => ({
          kind: 'client',
          client: { clientId, name: 'Example', redirectUris: ['myapp:/callback'] },
        }),
      })
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
    expect(await errorOf(response)).toBe('invalid_request');
  });

  it('answers 429 with Retry-After when the network used its metadata fetch allowance', async () => {
    let address: string | null = 'unset';
    const request = authorizeUrl({
      ...base,
      client_id: THIRD_PARTY,
      redirect_uri: 'https://client.example.com/callback',
    });
    const response = await call(
      new Request(request, { headers: { 'CF-Connecting-IP': '203.0.113.9' } }),
      oauthDeps(fakeGrants().access, {
        clients: async (_clientId, from) => {
          address = from;
          return { kind: 'rate_limited', retryAfterSeconds: 17 };
        },
      })
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('17');
    expect(response.headers.get('Location')).toBeNull();
    expect(await errorOf(response)).toBe('temporarily_unavailable');
    expect(address).toBe('203.0.113.9');
  });

  it.each([
    ['an unregistered scope', 'kilo-cli', 'gateway:unknown.read'],
    ['a scope of another first-party client', 'kilo-cli', 'user-data-export:exports.dispatch'],
    ['a scope for the web app only', 'kilo-cli', 'uts:security.read'],
    ['a scope that is not third-party-safe', THIRD_PARTY, 'kilo-api:profile.read'],
    ['a first-party-only service scope', THIRD_PARTY, 'event-service:events.subscribe'],
    ['an exchange-only scope for a third-party client', THIRD_PARTY, 'kilo-api:mcp.read'],
    ['an exchange-only scope for the CLI', 'kilo-cli', 'kilo-api:mcp.read'],
  ])('refuses %s before the hand-off and stores nothing', async (_name, clientId, scope) => {
    const grants = fakeGrants({
      issueCode: async () => ({ outcome: 'issued', orgRole: null }),
    });
    let handedOff = false;
    const thirdParty = clientId === THIRD_PARTY;
    const response = await call(
      authorizeUrl({
        ...base,
        client_id: clientId,
        scope,
        ...(thirdParty
          ? { redirect_uri: 'https://client.example.com/callback', dpop_jkt: '' }
          : {}),
      }),
      oauthDeps(grants.access, {
        clients: knownClient,
        handoff: async (request, next) => {
          handedOff = true;
          return await approve(request, next);
        },
      })
    );
    if (thirdParty) {
      expect(response.status).toBe(400);
      expect(response.headers.get('Location')).toBeNull();
      expect(await errorOf(response)).toBe('invalid_scope');
    } else {
      expect(redirectOf(response).searchParams.get('error')).toBe('invalid_scope');
      expect(redirectOf(response).searchParams.get('code')).toBeNull();
    }
    expect(handedOff).toBe(false);
    expect(grants.calls.filter(item => item.method === 'issueCode')).toEqual([]);
  });
});

describe('revocation endpoint', () => {
  it('revokes a refresh token, publishes its feed entry, and answers 200 for unknown and malformed tokens', async () => {
    const entry = grantEntry();
    const grants = fakeGrants({
      revoke: async () => ({ outcome: 'revoked', feedEntries: [entry] }),
    });
    const feed = recordingPublisher();
    const token = firstPartyRefreshToken(crypto.randomUUID(), randomCredential());
    const revoked = await call(
      formRequest('/revoke', { token, client_id: 'kilo-cli' }),
      oauthDeps(grants.access, { publish: feed.publish })
    );
    expect(revoked.status).toBe(200);
    expect(grants.calls).toHaveLength(1);
    expect(feed.batches).toEqual([[entry]]);

    const unknown = fakeGrants({ revoke: async () => ({ outcome: 'unknown', feedEntries: [] }) });
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
      const grants = fakeGrants({ revoke: async () => ({ outcome, feedEntries: [] }) });
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

  it('answers 503 when neither feed object took the entry, and the revocation stands', async () => {
    const grants = fakeGrants({
      revoke: async () => ({ outcome: 'revoked', feedEntries: [grantEntry()] }),
    });
    const feed = recordingPublisher('unpublished');
    const response = await call(
      formRequest('/revoke', { token: randomCredential(), client_id: THIRD_PARTY }),
      oauthDeps(grants.access, { publish: feed.publish })
    );
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toBe('temporarily_unavailable');
    expect(grants.calls).toHaveLength(1);
    expect(feed.batches).toHaveLength(1);
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
    const token = firstPartyRefreshToken(active.grantId, randomCredential());
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
        {
          token: firstPartyRefreshToken(active.grantId, randomCredential()),
          client_id: 'kilo-cli',
        },
        { DPoP: await dpopProof(await dpopKey(), INTROSPECT_URL) }
      ),
      oauthDeps(grants.access)
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_dpop_proof');
  });

  it('needs the proof for the introspection URL from a first-party client', async () => {
    const token = firstPartyRefreshToken(active.grantId, randomCredential());
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

  it('lists the authorization, token, revocation and introspection endpoints once the store is bound, and the device grant only with its user-code secret', async () => {
    const deployed = await metadata(await fetchMint(metadataRequest()));
    expect(deployed).toMatchObject({
      authorization_endpoint: `${config.endpoints.issuer}/authorize`,
      token_endpoint: `${config.endpoints.issuer}/token`,
      revocation_endpoint: `${config.endpoints.issuer}/revoke`,
      introspection_endpoint: `${config.endpoints.issuer}/introspect`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      dpop_signing_alg_values_supported: ['EdDSA', 'ES256'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(deployed.device_authorization_endpoint).toBeUndefined();
    expect(
      (await fetchMint(formRequest('/device_authorization', { client_id: 'kilo-cli' }))).status
    ).toBe(404);

    const withDevice = await metadata(
      await fetchMint(metadataRequest(), { ...env, DEVICE_USER_CODE_KEY: 'A'.repeat(43) })
    );
    expect(withDevice).toMatchObject({
      device_authorization_endpoint: `${config.endpoints.issuer}/device_authorization`,
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
    });
  });
});
