import {
  BrowserSessionEndAllSchema,
  BrowserSessionEndSchema,
  BrowserSessionGrantSchema,
  BrowserSessionReadSchema,
  BrowserSessionTokenSchema,
  DeviceRevokeSchema,
  LegacyBridgeGrantSchema,
  UTS_CLIENT_ASSERTION_TYPE,
  UTS_JWT_TOKEN_TYPE,
  type UtsScopeEntry,
} from '@kilocode/uts-contracts';
import { Buffer } from 'node:buffer';
import {
  type JWTPayload,
  SignJWT,
  calculateJwkThumbprint,
  decodeJwt,
  exportJWK,
  generateKeyPair,
} from 'jose';
import { describe, expect, it } from 'vitest';
import { legacyBridgeKeys, webClientKeys } from '../../src/bff/client-auth';
import type { LegacySsoAuthority, WebClientDeps } from '../../src/bff/deps';
import type { WebSession, WebSessionAccess, WebSessionStore } from '../../src/bff/store';
import type { PendingAuthorization } from '../../src/oauth/authorize';
import { authorizationServerMetadata } from '../../src/metadata/authorization-server';
import { handleOAuthRequest } from '../../src/oauth/routes';
import { browserSessionHandleOfExchange, randomCredential } from '../../src/token/credentials';
import {
  errorOf,
  fakeGrants,
  formRequest,
  oauthDeps,
  recordingPublisher,
  testScopes,
} from './oauth-support';
import { config } from './test-env';

/**
 * The web BFF `kilo-web` at the token endpoint and the browser-session API: client assertions,
 * the code exchange and its retry, the legacy bridge, and `read`, `token`, `end`, `end-all` and
 * `devices/revoke`, against a recording browser-session store and the real signer objects.
 */

const ISSUER = config.endpoints.issuer;
const TOKEN_URL = `${ISSUER}/token`;
const SESSION_ID = '4f1c3a52-8f0e-4d7e-9c4b-2a1e6b5d7c90';
const SUBJECT = 'app-user-42';
const REDIRECT = 'http://localhost:3000/api/auth/uts/callback';

type WebKey = { privateKey: CryptoKey; kid: string; jwks: string; jwk: Record<string, string> };

async function webKey(kidPrefix = 'kilo-web-'): Promise<WebKey> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const { x } = await exportJWK(publicKey);
  if (x === undefined) throw new Error('no public key');
  const kid = `${kidPrefix}${await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x })}`;
  const jwk = { kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig', kid, x };
  return { privateKey, kid, jwks: JSON.stringify({ keys: [jwk] }), jwk };
}

const KEY = await webKey();
const OTHER_KEY = await webKey();
/** The legacy bridge's own key, never a client assertion key. */
const BRIDGE_KEY = await webKey('kilo-bridge-');
const bridgeKeys = () =>
  legacyBridgeKeys({ KILO_WEB_BRIDGE_JWKS: BRIDGE_KEY.jwks, KILO_WEB_CLIENT_JWKS: KEY.jwks });

async function signed(
  key: WebKey,
  claims: JWTPayload,
  header: { typ?: string; kid?: string } = {}
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: header.kid ?? key.kid, ...header })
    .sign(key.privateKey);
}

const now = () => Math.floor(Date.now() / 1000);

/** A client assertion for `audience`; `claims` override the defaults. */
async function clientAssertion(audience: string, claims: JWTPayload = {}, key = KEY) {
  return await signed(key, {
    iss: 'kilo-web',
    sub: 'kilo-web',
    aud: audience,
    iat: now(),
    exp: now() + 120,
    jti: `jti-${crypto.randomUUID()}`,
    ...claims,
  });
}

async function assertionFields(audience: string, claims: JWTPayload = {}, key = KEY) {
  return {
    client_assertion_type: UTS_CLIENT_ASSERTION_TYPE,
    client_assertion: await clientAssertion(audience, claims, key),
  };
}

function session(overrides: Partial<WebSession> = {}): WebSession {
  const base = Date.now();
  return {
    sessionId: SESSION_ID,
    subject: SUBJECT,
    authTime: new Date(base - 3_600_000),
    amr: ['oauth'],
    sso: null,
    issuedAt: new Date(base - 60_000),
    idleExpiresAt: new Date(base + 14 * 86_400_000),
    expiresAt: new Date(base + 30 * 86_400_000),
    ...overrides,
  };
}

const minted = (scopes: string[], sessionOverrides: Partial<WebSession> = {}) => {
  const value = session(sessionOverrides);
  return {
    session: value,
    subjectId: value.subject,
    orgId: null,
    orgRole: null,
    authTime: value.authTime,
    amr: value.amr,
    tokenIds: scopes.map(() => crypto.randomUUID()),
    scopes,
  };
};

type Call = { method: keyof WebSessionStore; input: unknown };
type FakeSessions = { calls: Call[]; access: WebSessionAccess };

/** A browser-session store that answers with `implementation` and records every call. */
function fakeSessions(implementation: Partial<WebSessionStore> = {}): FakeSessions {
  const calls: Call[] = [];
  const recorded =
    <Input, Output>(
      method: keyof WebSessionStore,
      run: ((input: Input) => Promise<Output>) | undefined
    ) =>
    async (input: Input): Promise<Output> => {
      calls.push({ method, input });
      if (run === undefined) throw new Error(`unexpected ${method} call`);
      return await run(input);
    };
  const store: WebSessionStore = {
    exchangeCode: recorded('exchangeCode', implementation.exchangeCode),
    read: recorded('read', implementation.read),
    mint: recorded('mint', implementation.mint),
    end: recorded('end', implementation.end),
    endAll: recorded('endAll', implementation.endAll),
    revokeDevice: recorded('revokeDevice', implementation.revokeDevice),
    bridge: recorded('bridge', implementation.bridge),
  };
  return { calls, access: work => work(store) };
}

function webDeps(sessions: FakeSessions, overrides: Partial<WebClientDeps> = {}): WebClientDeps {
  const { sign, scopes } = oauthDeps(fakeGrants().access);
  return {
    config,
    keys: () => webClientKeys({ KILO_WEB_CLIENT_JWKS: KEY.jwks }),
    sessions: sessions.access,
    sign,
    scopes,
    publish: recordingPublisher().publish,
    bridge: { status: 'off' },
    windows: new Map(),
    now: Date.now,
    ...overrides,
  };
}

async function call(request: Request, web: WebClientDeps): Promise<Response> {
  const response = await handleOAuthRequest(
    request,
    new URL(request.url).pathname,
    oauthDeps(fakeGrants().access, { web })
  );
  if (response === null) throw new Error('the path is not served');
  return response;
}

describe('kilo-web client authentication', () => {
  const code = randomCredential();
  const verifier = randomCredential();
  const exchangeFields = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  };

  it('answers 503 with Retry-After while the key set is unset or invalid, before any statement', async () => {
    const sessions = fakeSessions();
    for (const jwks of [undefined, '{"keys":[]}', OTHER_KEY.jwks.replace(OTHER_KEY.kid, KEY.kid)]) {
      const web = webDeps(sessions, { keys: () => webClientKeys({ KILO_WEB_CLIENT_JWKS: jwks }) });
      const token = await call(
        formRequest('/token', { ...exchangeFields, ...(await assertionFields(TOKEN_URL)) }),
        web
      );
      expect(token.status).toBe(503);
      expect(token.headers.get('Retry-After')).toBe('60');
      const read = await call(
        formRequest('/account/browser-sessions/read', {
          ...(await assertionFields(`${ISSUER}/account/browser-sessions/read`)),
          session_handle: randomCredential(),
        }),
        web
      );
      expect(read.status).toBe(503);
    }
    expect(sessions.calls).toEqual([]);
  });

  it.each([
    ['another audience', { aud: `${ISSUER}/account/browser-sessions/read` }, {}],
    ['an audience list', { aud: [TOKEN_URL] }, {}],
    ['another issuer', { iss: 'kilo-cli' }, {}],
    ['another subject', { sub: 'someone' }, {}],
    ['an expired assertion', { iat: now() - 400, exp: now() - 100 }, {}],
    ['a lifetime over 300 seconds', { exp: now() + 400 }, {}],
    ['a short jti', { jti: 'short' }, {}],
    ['no jti', { jti: undefined }, {}],
    ['an unknown kid', {}, { kid: OTHER_KEY.kid }],
    ['the legacy session typ', {}, { typ: 'kilo-legacy-session+jwt' }],
  ])('refuses %s with invalid_client before any statement', async (_name, claims, header) => {
    const sessions = fakeSessions();
    const assertion = await signed(
      KEY,
      {
        iss: 'kilo-web',
        sub: 'kilo-web',
        aud: TOKEN_URL,
        iat: now(),
        exp: now() + 120,
        jti: `jti-${crypto.randomUUID()}`,
        ...claims,
      },
      header
    );
    const response = await call(
      formRequest('/token', {
        ...exchangeFields,
        client_assertion_type: UTS_CLIENT_ASSERTION_TYPE,
        client_assertion: assertion,
      }),
      webDeps(sessions)
    );
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe('invalid_client');
    expect(sessions.calls).toEqual([]);
  });

  it('refuses an assertion signed by a key the set does not hold', async () => {
    const sessions = fakeSessions();
    const forged = await signed(
      OTHER_KEY,
      {
        iss: 'kilo-web',
        sub: 'kilo-web',
        aud: TOKEN_URL,
        iat: now(),
        exp: now() + 60,
        jti: `jti-${crypto.randomUUID()}`,
      },
      { kid: KEY.kid }
    );
    const response = await call(
      formRequest('/token', {
        ...exchangeFields,
        client_assertion_type: UTS_CLIENT_ASSERTION_TYPE,
        client_assertion: forged,
      }),
      webDeps(sessions)
    );
    expect(await errorOf(response)).toBe('invalid_client');
  });

  it('answers a replayed assertion invalid_client, and refuses refresh for the web client', async () => {
    const sessions = fakeSessions({ exchangeCode: async () => ({ outcome: 'assertion_replay' }) });
    const replay = await call(
      formRequest('/token', { ...exchangeFields, ...(await assertionFields(TOKEN_URL)) }),
      webDeps(sessions)
    );
    expect(replay.status).toBe(401);
    expect(await errorOf(replay)).toBe('invalid_client');
    const refresh = await call(
      formRequest('/token', {
        grant_type: 'refresh_token',
        refresh_token: 'x',
        ...(await assertionFields(TOKEN_URL)),
      }),
      webDeps(sessions)
    );
    expect(await errorOf(refresh)).toBe('unauthorized_client');
  });

  it('treats kilo-web without an assertion as an unknown public client', async () => {
    const response = await call(
      formRequest('/token', { ...exchangeFields, client_id: 'kilo-web' }),
      webDeps(fakeSessions())
    );
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe('invalid_client');
  });
});

describe('kilo-web code exchange', () => {
  it('answers the session and its handle, with tokens whose sid is the session id', async () => {
    const code = randomCredential();
    const verifier = randomCredential();
    const sessions = fakeSessions({
      exchangeCode: async () => ({ outcome: 'issued', ...minted(['uts:browser-session.read']) }),
    });
    const fields = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    };
    const first = await call(
      formRequest('/token', { ...fields, ...(await assertionFields(TOKEN_URL)) }),
      webDeps(sessions)
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    const body = BrowserSessionGrantSchema.parse(await first.json());
    expect(body).toMatchObject({
      session_id: SESSION_ID,
      subject: SUBJECT,
      amr: ['oauth'],
      scope: 'uts:browser-session.read',
      session_handle: await browserSessionHandleOfExchange(code, verifier),
    });
    expect(body).not.toHaveProperty('refresh_token');
    expect(body).not.toHaveProperty('sso_connection');
    expect(decodeJwt(body.access_token)).toMatchObject({
      sub: SUBJECT,
      sid: SESSION_ID,
      client_id: 'kilo-web',
      aud: 'uts',
      amr: ['oauth'],
    });
    // A retry with the same code and verifier carries the same handle.
    const retry = BrowserSessionGrantSchema.parse(
      await (
        await call(
          formRequest('/token', { ...fields, ...(await assertionFields(TOKEN_URL)) }),
          webDeps(sessions)
        )
      ).json()
    );
    expect(retry.session_handle).toBe(body.session_handle);
    expect(retry.access_token).not.toBe(body.access_token);
    const [input] = sessions.calls.map(entry => entry.input);
    expect(input).toMatchObject({ clientId: 'kilo-web', redirectUri: REDIRECT, scopes: null });
  });

  it('carries the WorkOS ids of an SSO session', async () => {
    const sessions = fakeSessions({
      exchangeCode: async () => ({
        outcome: 'issued',
        ...minted(['uts:browser-session.read'], {
          amr: ['sso'],
          sso: { connection: 'conn_1', organization: 'org_1' },
        }),
      }),
    });
    const response = await call(
      formRequest('/token', {
        grant_type: 'authorization_code',
        code: randomCredential(),
        redirect_uri: REDIRECT,
        code_verifier: randomCredential(),
        ...(await assertionFields(TOKEN_URL)),
      }),
      webDeps(sessions)
    );
    expect(BrowserSessionGrantSchema.parse(await response.json())).toMatchObject({
      amr: ['sso'],
      sso_connection: 'conn_1',
      sso_organization: 'org_1',
    });
  });

  it('refuses a DPoP proof and maps refused exchanges to invalid_grant', async () => {
    const sessions = fakeSessions({ exchangeCode: async () => ({ outcome: 'invalid_grant' }) });
    const fields = async () => ({
      grant_type: 'authorization_code',
      code: randomCredential(),
      redirect_uri: REDIRECT,
      code_verifier: randomCredential(),
      ...(await assertionFields(TOKEN_URL)),
    });
    const dpop = await call(
      formRequest('/token', await fields(), { DPoP: 'x' }),
      webDeps(sessions)
    );
    expect(await errorOf(dpop)).toBe('invalid_request');
    const refused = await call(formRequest('/token', await fields()), webDeps(sessions));
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toBe('invalid_grant');
  });
});

describe('legacy bridge', () => {
  const legacyToken = async (
    claims: JWTPayload = {},
    key = BRIDGE_KEY,
    typ = 'kilo-legacy-session+jwt'
  ) =>
    await signed(
      key,
      {
        iss: 'kilo-web',
        sub: SUBJECT,
        aud: TOKEN_URL,
        iat: now(),
        exp: now() + 30,
        jti: `legacy-${crypto.randomUUID()}`,
        auth_time: now() - 86_400,
        ...claims,
      },
      { typ }
    );
  const bridgeFields = async (subjectToken: string) => ({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: subjectToken,
    subject_token_type: UTS_JWT_TOKEN_TYPE,
    ...(await assertionFields(TOKEN_URL)),
  });

  it('is off unless enabled', async () => {
    const sessions = fakeSessions();
    const response = await call(
      formRequest('/token', await bridgeFields(await legacyToken())),
      webDeps(sessions)
    );
    expect(await errorOf(response)).toBe('unsupported_grant_type');
    expect(sessions.calls).toEqual([]);
  });

  it('bridges with legacy_session and drops SSO provenance its authority check does not confirm', async () => {
    const sessions = fakeSessions({
      bridge: async () => ({
        outcome: 'issued',
        ...minted(['uts:browser-session.read'], { amr: ['legacy_session'] }),
      }),
    });
    const authority: LegacySsoAuthority = async () => 'unverified';
    const response = await call(
      formRequest(
        '/token',
        await bridgeFields(
          await legacyToken({ sso_connection: 'conn_1', sso_organization: 'org_1' })
        )
      ),
      webDeps(sessions, { bridge: { status: 'on', authority, keys: bridgeKeys } })
    );
    expect(response.status).toBe(200);
    const body = LegacyBridgeGrantSchema.parse(await response.json());
    expect(body).toMatchObject({ amr: ['legacy_session'], subject: SUBJECT });
    expect(sessions.calls[0].input).toMatchObject({
      accountId: SUBJECT,
      sso: null,
      scopes: ['uts:browser-session.read'],
    });
  });

  it('passes SSO provenance its authority check confirms', async () => {
    const sessions = fakeSessions({
      bridge: async () => ({
        outcome: 'issued',
        ...minted(['uts:browser-session.read'], {
          amr: ['legacy_session', 'sso'],
          sso: { connection: 'conn_1', organization: 'org_1' },
        }),
      }),
    });
    const claims: unknown[] = [];
    const authority: LegacySsoAuthority = async claim => {
      claims.push(claim);
      return 'verified';
    };
    await call(
      formRequest(
        '/token',
        await bridgeFields(
          await legacyToken({ sso_connection: 'conn_1', sso_organization: 'org_1' })
        )
      ),
      webDeps(sessions, { bridge: { status: 'on', authority, keys: bridgeKeys } })
    );
    expect(claims).toEqual([{ subject: SUBJECT, connection: 'conn_1', organization: 'org_1' }]);
    expect(sessions.calls[0].input).toMatchObject({
      sso: { connection: 'conn_1', organization: 'org_1' },
    });
  });

  it.each([
    ['the client assertion typ', { typ: 'JWT' }],
    ['a lifetime over 60 seconds', { claims: { exp: now() + 90 } }],
    ['another audience', { claims: { aud: `${ISSUER}/other` } }],
    ['a future sign-in', { claims: { auth_time: now() + 600 } }],
    ['another key', { key: OTHER_KEY }],
  ])('refuses a subject token with %s as invalid_grant', async (_name, variant) => {
    const sessions = fakeSessions();
    const subjectToken =
      'key' in variant
        ? await signed(
            variant.key,
            {
              iss: 'kilo-web',
              sub: SUBJECT,
              aud: TOKEN_URL,
              iat: now(),
              exp: now() + 30,
              jti: `legacy-${crypto.randomUUID()}`,
              auth_time: now(),
            },
            { typ: 'kilo-legacy-session+jwt', kid: BRIDGE_KEY.kid }
          )
        : await legacyToken(
            'claims' in variant ? variant.claims : {},
            BRIDGE_KEY,
            'typ' in variant ? variant.typ : undefined
          );
    const response = await call(
      formRequest('/token', await bridgeFields(subjectToken)),
      webDeps(sessions, {
        bridge: { status: 'on', authority: async () => 'unverified', keys: bridgeKeys },
      })
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_grant');
    expect(sessions.calls).toEqual([]);
  });

  it('refuses a subject token signed by the client assertion key', async () => {
    const sessions = fakeSessions();
    const response = await call(
      formRequest('/token', await bridgeFields(await legacyToken({}, KEY))),
      webDeps(sessions, {
        bridge: { status: 'on', authority: async () => 'unverified', keys: bridgeKeys },
      })
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_grant');
    expect(sessions.calls).toEqual([]);
  });

  it('answers 503 without its own key set, and when that set reuses a client key', async () => {
    const reused = JSON.stringify({
      keys: [{ ...KEY.jwk, kid: KEY.kid.replace('kilo-web-', 'kilo-bridge-') }],
    });
    for (const KILO_WEB_BRIDGE_JWKS of [undefined, reused]) {
      const sessions = fakeSessions();
      const response = await call(
        formRequest('/token', await bridgeFields(await legacyToken())),
        webDeps(sessions, {
          bridge: {
            status: 'on',
            authority: async () => 'unverified',
            keys: () => legacyBridgeKeys({ KILO_WEB_BRIDGE_JWKS, KILO_WEB_CLIENT_JWKS: KEY.jwks }),
          },
        })
      );
      expect(response.status).toBe(503);
      expect(sessions.calls).toEqual([]);
    }
  });
});

describe('browser-session API', () => {
  const path = (name: string) => `/account/browser-sessions/${name}`;
  const fields = async (
    name: string,
    extra: Record<string, string> = {},
    handle = randomCredential()
  ) => ({
    ...(await assertionFields(`${ISSUER}${path(name)}`)),
    session_handle: handle,
    ...extra,
  });

  it('reads a live session and refuses every other handle with invalid_session', async () => {
    const live = fakeSessions({ read: async () => ({ outcome: 'active', session: session() }) });
    const ok = await call(formRequest(path('read'), await fields('read')), webDeps(live));
    expect(BrowserSessionReadSchema.parse(await ok.json())).toMatchObject({
      status: 'active',
      session_id: SESSION_ID,
      subject: SUBJECT,
    });
    const dead = fakeSessions({ read: async () => ({ outcome: 'invalid_session' }) });
    const refused = await call(formRequest(path('read'), await fields('read')), webDeps(dead));
    expect(refused.status).toBe(401);
    expect(await errorOf(refused)).toBe('invalid_session');
    const noHandle = await call(
      formRequest(path('read'), await assertionFields(`${ISSUER}${path('read')}`)),
      webDeps(dead)
    );
    expect(await errorOf(noHandle)).toBe('invalid_request');
  });

  it('refuses an assertion for another browser-session endpoint', async () => {
    const sessions = fakeSessions();
    const response = await call(
      formRequest(path('end'), {
        ...(await assertionFields(`${ISSUER}${path('read')}`)),
        session_handle: randomCredential(),
      }),
      webDeps(sessions)
    );
    expect(await errorOf(response)).toBe('invalid_client');
    expect(sessions.calls).toEqual([]);
  });

  it('mints one token for one registered scope and its exact resource origin', async () => {
    const sessions = fakeSessions({
      mint: async () => ({
        outcome: 'issued',
        sessionId: SESSION_ID,
        subjectId: SUBJECT,
        orgId: null,
        orgRole: null,
        authTime: new Date(),
        amr: ['oauth'],
        tokenIds: [crypto.randomUUID()],
        scopes: ['uts:browser-session.read'],
      }),
    });
    const ok = await call(
      formRequest(
        path('token'),
        await fields('token', { scope: 'uts:browser-session.read', resource: ISSUER })
      ),
      webDeps(sessions)
    );
    const body = BrowserSessionTokenSchema.parse(await ok.json());
    expect(decodeJwt(body.access_token)).toMatchObject({
      sid: SESSION_ID,
      scope: 'uts:browser-session.read',
    });
    expect(sessions.calls[0].input).toMatchObject({
      scope: 'uts:browser-session.read',
      stepUp: false,
    });

    for (const [extra, error] of [
      [{ scope: 'kilo-api:profile.read', resource: 'http://localhost:3000' }, 'invalid_scope'],
      [{ scope: 'uts:browser-session.read', resource: 'urn:kilo:service:uts' }, 'invalid_target'],
      [{ scope: 'uts:browser-session.read', resource: 'http://localhost:3000' }, 'invalid_target'],
      [
        {
          scope: 'git-token-service:bitbucket.repositories.read',
          resource: 'http://localhost:8802',
        },
        'invalid_scope',
      ],
      [{ scope: 'uts:browser-session.read' }, 'invalid_request'],
    ] as const) {
      const refused = await call(
        formRequest(path('token'), await fields('token', extra)),
        webDeps(sessions)
      );
      expect(await errorOf(refused)).toBe(error);
    }
    expect(sessions.calls).toHaveLength(1);
  });

  it('answers a step-up scope without a recent passkey with the RFC 9470 challenge', async () => {
    const sessions = fakeSessions({ mint: async () => ({ outcome: 'step_up_required' }) });
    const response = await call(
      formRequest(
        path('token'),
        await fields('token', { scope: 'uts:browser-session.read', resource: ISSUER })
      ),
      webDeps(sessions)
    );
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe('insufficient_user_authentication');
    expect(response.headers.get('WWW-Authenticate')).toContain('max_age="600"');
  });

  it('ends one session once the feed took its entry, and answers 503 with Retry-After until then', async () => {
    const entry = {
      kind: 'session' as const,
      id: SESSION_ID,
      revokedBefore: null,
      revokedAt: Date.now(),
      expiresAt: Date.now() + 1_200_000,
    };
    const sessions = fakeSessions({
      end: async () => ({ outcome: 'ended', sessionId: SESSION_ID, feedEntries: [entry] }),
    });
    const published = recordingPublisher();
    const ok = await call(
      formRequest(path('end'), await fields('end')),
      webDeps(sessions, { publish: published.publish })
    );
    expect(BrowserSessionEndSchema.parse(await ok.json())).toEqual({
      status: 'ended',
      session_id: SESSION_ID,
    });
    expect(published.batches).toEqual([[entry]]);

    const down = await call(
      formRequest(path('end'), await fields('end')),
      webDeps(sessions, { publish: recordingPublisher('unpublished').publish })
    );
    expect(down.status).toBe(503);
    expect(down.headers.get('Retry-After')).not.toBeNull();

    const repeat = fakeSessions({
      end: async () => ({ outcome: 'already_ended', feedEntries: [] }),
    });
    const again = await call(formRequest(path('end'), await fields('end')), webDeps(repeat));
    expect(BrowserSessionEndSchema.parse(await again.json())).toEqual({ status: 'ended' });
  });

  it('ends every browser session and answers how many', async () => {
    const sessions = fakeSessions({
      endAll: async () => ({ outcome: 'ended', ended: 3, feedEntries: [] }),
    });
    const response = await call(
      formRequest(path('end-all'), await fields('end-all')),
      webDeps(sessions)
    );
    expect(BrowserSessionEndAllSchema.parse(await response.json())).toEqual({
      status: 'ended',
      ended: 3,
    });
  });

  it('revokes one device by sid and refuses a malformed sid', async () => {
    const sessions = fakeSessions({
      revokeDevice: async () => ({ outcome: 'ended', feedEntries: [] }),
    });
    const devicePath = '/account/devices/revoke';
    const deviceFields = async (sid: string) => ({
      ...(await assertionFields(`${ISSUER}${devicePath}`)),
      session_handle: randomCredential(),
      sid,
    });
    const sid = crypto.randomUUID();
    const ok = await call(formRequest(devicePath, await deviceFields(sid)), webDeps(sessions));
    expect(DeviceRevokeSchema.parse(await ok.json())).toEqual({ status: 'ended' });
    expect(sessions.calls[0].input).toMatchObject({ sid });
    const bad = await call(
      formRequest(devicePath, await deviceFields('not-a-uuid')),
      webDeps(sessions)
    );
    expect(await errorOf(bad)).toBe('invalid_request');
  });

  it('answers 429 slow_down with Retry-After past 60 calls a minute for one handle', async () => {
    const sessions = fakeSessions({
      read: async () => ({ outcome: 'active', session: session() }),
    });
    const handle = randomCredential();
    let tick = Date.now();
    const web = webDeps(sessions, { now: () => tick });
    for (let index = 0; index < 60; index += 1) {
      expect(
        (await call(formRequest(path('read'), await fields('read', {}, handle)), web)).status
      ).toBe(200);
    }
    const limited = await call(formRequest(path('read'), await fields('read', {}, handle)), web);
    expect(limited.status).toBe(429);
    expect(await errorOf(limited)).toBe('slow_down');
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await call(formRequest(path('read'), await fields('read')), web)).status).toBe(200);
    tick += 61_000;
    expect(
      (await call(formRequest(path('read'), await fields('read', {}, handle)), web)).status
    ).toBe(200);
    expect(sessions.calls).toHaveLength(62);
  });
});

describe('authorize for kilo-web', () => {
  const approved = async (_request: Request, pending: PendingAuthorization) => {
    expect(pending.client).toEqual({
      kind: 'confidential_web',
      clientId: 'kilo-web',
      name: 'Kilo web app',
    });
    return {
      status: 'approved' as const,
      approval: {
        clientKind: 'first_party' as const,
        accountId: SUBJECT,
        browserSessionId: SESSION_ID,
        authTime: new Date(),
        amr: ['oauth' as const],
        orgId: null,
      },
    };
  };
  const authorizeUrl = (extra: Record<string, string> = {}) => {
    const url = new URL(`${ISSUER}/authorize`);
    const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    for (const [name, value] of Object.entries({
      client_id: 'kilo-web',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'uts:browser-session.read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's-1',
      ...extra,
    })) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  };
  const authorize = async (url: string, issueCode = true, keys?: WebClientDeps['keys']) => {
    const grants = fakeGrants(
      issueCode ? { issueCode: async () => ({ outcome: 'issued', orgRole: null }) } : {}
    );
    const web = webDeps(fakeSessions(), keys === undefined ? {} : { keys });
    const response = await handleOAuthRequest(
      new Request(url),
      '/authorize',
      oauthDeps(grants.access, { web, handoff: approved })
    );
    if (response === null) throw new Error('not served');
    return { response, calls: grants.calls };
  };

  it('issues a code on the exact callback, with iss, for the session it was approved in', async () => {
    const { response, calls } = await authorize(authorizeUrl({ resource: ISSUER }));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(location.searchParams.get('code')).not.toBeNull();
    expect(calls[0].input).toMatchObject({
      client: { kind: 'confidential_web', clientId: 'kilo-web' },
      browserSessionId: SESSION_ID,
    });
  });

  it('shows a wrong redirect on the page and never redirects', async () => {
    const { response } = await authorize(
      authorizeUrl({ redirect_uri: 'http://localhost:3000/api/auth/uts/other' }),
      false
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('Location')).toBeNull();
  });

  it.each([
    ['a DPoP key', { dpop_jkt: 'A'.repeat(43) }, 'invalid_request'],
    ['a resource other than the issuer', { resource: 'http://localhost:3000' }, 'invalid_target'],
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
  ])('redirects %s back as an error with iss', async (_name, extra, error) => {
    const { response } = await authorize(authorizeUrl(extra), false);
    const location = new URL(response.headers.get('Location') ?? '');
    expect(location.searchParams.get('error')).toBe(error);
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(location.searchParams.get('state')).toBe('s-1');
  });

  it('answers 503 on the page while the key set is unset', async () => {
    const { response } = await authorize(authorizeUrl(), false, async () => ({
      status: 'unconfigured',
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get('Location')).toBeNull();
  });
});

describe('authorization-server metadata for kilo-web', () => {
  const metadata = (web: Partial<WebClientDeps>, webClientReady: boolean) =>
    authorizationServerMetadata(
      config,
      {
        kind: 'ready',
        deps: oauthDeps(fakeGrants().access, { web: webDeps(fakeSessions(), web) }),
      },
      webClientReady,
      false
    );

  it('lists private_key_jwt only while the key set is valid, and the exchange only with the bridge on', () => {
    const unset = metadata({}, false);
    expect(unset.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(unset).not.toHaveProperty('token_endpoint_auth_signing_alg_values_supported');
    expect(unset.grant_types_supported).not.toContain(
      'urn:ietf:params:oauth:grant-type:token-exchange'
    );

    const ready = metadata({}, true);
    expect(ready.token_endpoint_auth_methods_supported).toEqual(['none', 'private_key_jwt']);
    expect(ready).toMatchObject({ token_endpoint_auth_signing_alg_values_supported: ['EdDSA'] });
    expect(ready.grant_types_supported).not.toContain(
      'urn:ietf:params:oauth:grant-type:token-exchange'
    );

    const authority: LegacySsoAuthority = async () => 'unverified';
    const bridge: WebClientDeps['bridge'] = { status: 'on', authority, keys: bridgeKeys };
    expect(metadata({ bridge }, true).grant_types_supported).toContain(
      'urn:ietf:params:oauth:grant-type:token-exchange'
    );
    // A bridge without a valid key set answers nothing, so it is not listed.
    expect(metadata({ bridge }, false).grant_types_supported).not.toContain(
      'urn:ietf:params:oauth:grant-type:token-exchange'
    );
  });
});

describe('a kilo-web scope that needs a step-up', () => {
  // The registry holds no such scope yet; this fixture is the first one that will.
  const STEP_UP = 'uts:fixture.step-up';
  const entry: UtsScopeEntry = {
    audience: 'uts',
    maxLifetimeSeconds: 300,
    allowedClients: ['kilo-web'],
    subjects: { kind: 'any_user' },
    thirdPartySafe: false,
    stepUp: true,
    patEligible: false,
    privileged: true,
    requiresSession: true,
    requiresOrgClaim: false,
    delegable: false,
    issuance: 'grant',
    delegatesTo: [],
    consentText: null,
  };
  const scopes = (scope: string) => (scope === STEP_UP ? entry : testScopes(scope));
  const unverified: LegacySsoAuthority = async () => 'unverified';

  it('is refused at /authorize, with iss', async () => {
    const url = new URL(`${ISSUER}/authorize`);
    for (const [name, value] of Object.entries({
      client_id: 'kilo-web',
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: STEP_UP,
      code_challenge: randomCredential(),
      code_challenge_method: 'S256',
    })) {
      url.searchParams.set(name, value);
    }
    const grants = fakeGrants();
    const response = await handleOAuthRequest(
      new Request(url),
      '/authorize',
      oauthDeps(grants.access, { scopes, web: webDeps(fakeSessions(), { scopes }) })
    );
    const location = new URL(response?.headers.get('Location') ?? 'invalid:');
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('iss')).toBe(ISSUER);
    expect(grants.calls).toEqual([]);
  });

  it('is refused by the code exchange, named or held by the code, and by the legacy bridge', async () => {
    const exchangeFields = async (extra: Record<string, string>) => ({
      grant_type: 'authorization_code',
      code: randomCredential(),
      redirect_uri: REDIRECT,
      code_verifier: randomCredential(),
      ...extra,
      ...(await assertionFields(TOKEN_URL)),
    });
    const named = fakeSessions();
    const namedAnswer = await call(
      formRequest('/token', await exchangeFields({ scope: STEP_UP })),
      webDeps(named, { scopes })
    );
    expect(await errorOf(namedAnswer)).toBe('invalid_scope');
    expect(named.calls).toEqual([]);

    // A code that holds the scope: the answer is refused before anything is signed.
    const held = fakeSessions({
      exchangeCode: async () => ({ outcome: 'issued', ...minted([STEP_UP]) }),
    });
    const heldAnswer = await call(
      formRequest('/token', await exchangeFields({})),
      webDeps(held, { scopes })
    );
    expect(heldAnswer.status).toBe(400);
    expect(await errorOf(heldAnswer)).toBe('invalid_scope');

    const bridge = fakeSessions();
    const bridged = await call(
      formRequest('/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: await signed(
          BRIDGE_KEY,
          {
            iss: 'kilo-web',
            sub: SUBJECT,
            aud: TOKEN_URL,
            iat: now(),
            exp: now() + 30,
            jti: `legacy-${crypto.randomUUID()}`,
            auth_time: now() - 60,
          },
          { typ: 'kilo-legacy-session+jwt' }
        ),
        subject_token_type: UTS_JWT_TOKEN_TYPE,
        scope: STEP_UP,
        ...(await assertionFields(TOKEN_URL)),
      }),
      webDeps(bridge, {
        scopes,
        bridge: { status: 'on', authority: unverified, keys: bridgeKeys },
      })
    );
    expect(await errorOf(bridged)).toBe('invalid_scope');
    expect(bridge.calls).toEqual([]);
  });

  it('is minted only by the browser-session token call, which asks the store for the passkey', async () => {
    const sessions = fakeSessions({ mint: async () => ({ outcome: 'step_up_required' }) });
    const response = await call(
      formRequest('/account/browser-sessions/token', {
        ...(await assertionFields(`${ISSUER}/account/browser-sessions/token`)),
        session_handle: randomCredential(),
        scope: STEP_UP,
        resource: ISSUER,
      }),
      webDeps(sessions, { scopes })
    );
    expect(await errorOf(response)).toBe('insufficient_user_authentication');
    expect(sessions.calls[0].input).toMatchObject({ scope: STEP_UP, stepUp: true });
  });
});

describe('end with a handle that names no stored session', () => {
  it('answers 401 invalid_session and publishes nothing', async () => {
    const published = recordingPublisher();
    const response = await call(
      formRequest('/account/browser-sessions/end', {
        ...(await assertionFields(`${ISSUER}/account/browser-sessions/end`)),
        session_handle: randomCredential(),
      }),
      webDeps(fakeSessions({ end: async () => ({ outcome: 'invalid_session' }) }), {
        publish: published.publish,
      })
    );
    expect(response.status).toBe(401);
    expect(await errorOf(response)).toBe('invalid_session');
    expect(published.batches).toEqual([]);
  });
});
