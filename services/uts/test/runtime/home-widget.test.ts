import {
  FEED_HEAD_TYPE,
  HomeWidgetGrantResponseSchema,
  KILO_API_AUDIENCE,
  KILO_API_HOME_WIDGET_SCOPE,
  KILO_GATEWAY_AUDIENCE,
  KILO_GATEWAY_INFERENCE_SCOPE,
  TokenResponseSchema,
  UTS_ACCESS_TOKEN_TYPE_URN,
  UTS_REFRESH_TOKEN_TYPE_URN,
  feedKid,
  feedListHash,
  utsScopeEntry,
} from '@kilocode/uts-contracts';
import { type RevocationFeedSource, type VerifyResult, createVerifier } from '@kilocode/verify';
import { Buffer } from 'node:buffer';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import type {
  FirstPartyRefreshInput,
  GrantsAccess,
  HomeWidgetExchangeInput,
  HomeWidgetExchangeResult,
  RevokeInput,
} from '../../src/grants/store';
import { type OAuthDeps, handleOAuthRequest } from '../../src/oauth/routes';
import {
  firstPartyRefreshToken,
  grantIdOfFirstPartyRefreshToken,
  randomCredential,
  sha256,
} from '../../src/token/credentials';
import { keySet } from './support';
import {
  type DpopKey,
  dpopKey,
  dpopProof,
  errorOf,
  fakeGrants,
  formRequest,
  grantEntry,
  minted,
  oauthDeps,
  recordingPublisher,
  storeFailure,
} from './oauth-support';
import { config } from './test-env';

/**
 * The home-widget exchange (src/home-widget/exchange.ts) end to end in the Workers pool: the
 * endpoint over a recording grant store and the real signer objects, and every token checked by
 * `@kilocode/verify`, the verifier the widget's backend runs, against the pool's UTS key set and a
 * revocation feed signed under a test feed key. test/db/home-widget.test.ts runs the statement.
 */

const SUBJECT = 'oauth/widget-user';
const ORG = '7c1f6d0e-4a52-4b8e-9f3c-2d6a1b0e5f47';
const DAY_MS = 86_400_000;

async function call(request: Request, deps: OAuthDeps): Promise<Response> {
  const response = await handleOAuthRequest(request, new URL(request.url).pathname, deps);
  if (response === null) throw new Error('not an OAuth path');
  return response;
}

const onDeps = (grants: { access: GrantsAccess }, overrides: Partial<OAuthDeps> = {}) =>
  oauthDeps(grants.access, { homeWidget: { status: 'on' }, ...overrides });

/** The mobile app's refresh token of a grant with a random id. */
const appRefreshToken = () => firstPartyRefreshToken(crypto.randomUUID(), randomCredential());

async function exchangeRequest(
  key: DpopKey,
  appToken: string,
  extra: Record<string, string> = {}
): Promise<Request> {
  return formRequest(
    '/token',
    {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'kilo-mobile',
      subject_token: appToken,
      subject_token_type: UTS_REFRESH_TOKEN_TYPE_URN,
      scope: KILO_API_HOME_WIDGET_SCOPE,
      ...extra,
    },
    { DPoP: await dpopProof(key) }
  );
}

/** A store answer for a widget grant of `SUBJECT`, in the organization the request named. */
function issued(input: HomeWidgetExchangeInput, replaced: string[] = []): HomeWidgetExchangeResult {
  return {
    outcome: 'issued',
    refreshExpiresAt: new Date(Date.now() + 60 * DAY_MS),
    feedEntries: replaced.map(id => grantEntry(id)),
    ...minted({ subjectId: SUBJECT, orgId: input.orgId, scopes: [KILO_API_HOME_WIDGET_SCOPE] }),
  };
}

/**
 * A revocation feed of one object under a test feed key, serving whatever `revokedSids` holds at
 * each head read, and the key set the verifier loads: the pool's signer keys plus that feed key.
 */
async function feed(revokedSids: readonly string[]) {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const exported = await exportJWK(publicKey);
  const kid = feedKid(0, await calculateJwkThumbprint(exported, 'sha256'));
  const lists = new Map<string, Uint8Array<ArrayBuffer>>();
  const source: RevocationFeedSource = {
    async head() {
      const bytes = new Uint8Array(
        new TextEncoder().encode(
          JSON.stringify({
            revoked_before: {},
            revoked_sids: revokedSids,
            revoked_kids: [],
            revoked_pat_ids: [],
            blocked_accounts: [],
          })
        )
      );
      const hash = await feedListHash(bytes);
      lists.set(hash, bytes);
      return await new SignJWT({ iat: Math.floor(Date.now() / 1000), list_hash: hash })
        .setProtectedHeader({ alg: 'EdDSA', typ: FEED_HEAD_TYPE, kid })
        .sign(privateKey);
    },
    async list(hash) {
      const bytes = lists.get(hash);
      if (bytes === undefined) throw new Error('no such list');
      return bytes;
    },
  };
  const signers = await keySet();
  const jwks = { keys: [...signers.keys, { ...exported, kid, alg: 'EdDSA', use: 'sig' }] };
  return { source, jwks };
}

/** Verifies `token` as `audience`'s route for `scope`, as a cold verifier of that service would. */
async function verifyAt(
  token: string,
  audience: string,
  scope: string,
  revokedSids: readonly string[] = []
): Promise<VerifyResult> {
  const { source, jwks } = await feed(revokedSids);
  const verifier = createVerifier({
    audience,
    environment: config.environment,
    resourceMetadataUrl: 'http://localhost:3000/.well-known/oauth-protected-resource',
    uts: {
      issuer: config.endpoints.issuer,
      jwks: async () => ({ body: jwks, age: 0, oldestAge: 0 }),
      scopeRegistry: (scopeAudience, name) => {
        const entry = utsScopeEntry(name);
        return entry === null || entry.audience !== scopeAudience ? null : entry;
      },
      revocation: source,
    },
  });
  const pending: Array<Promise<unknown>> = [];
  const result = await verifier.verify(
    `Bearer ${token}`,
    { issuer: 'uts', scope, requiresSession: true },
    { waitUntil: promise => void pending.push(promise) }
  );
  await Promise.allSettled(pending);
  return result;
}

describe('home-widget exchange: issue', () => {
  it('exchanges the app grant for a widget grant whose token the widget backend verifies', async () => {
    const key = await dpopKey();
    const appToken = appRefreshToken();
    const grants = fakeGrants({ exchangeHomeWidget: async input => issued(input) });
    const publisher = recordingPublisher();

    const response = await call(
      await exchangeRequest(key, appToken),
      onDeps(grants, { publish: publisher.publish })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = HomeWidgetGrantResponseSchema.parse(await response.json());
    expect(body.issued_token_type).toBe(UTS_ACCESS_TOKEN_TYPE_URN);
    expect(body.refresh_token_expires_in).toBeGreaterThan(59 * 86_400);

    const [{ method, input }] = grants.calls;
    expect(method).toBe('exchangeHomeWidget');
    const stored = input as HomeWidgetExchangeInput;
    const widgetGrantId = grantIdOfFirstPartyRefreshToken(body.refresh_token);
    expect(stored).toMatchObject({
      environment: 'development',
      parentGrantId: grantIdOfFirstPartyRefreshToken(appToken),
      clientId: 'kilo-mobile',
      widgetGrantId,
      scope: KILO_API_HOME_WIDGET_SCOPE,
      orgId: null,
    });
    expect(Buffer.from(stored.parentTokenHash)).toEqual(Buffer.from(await sha256(appToken)));
    expect(Buffer.from(stored.widgetTokenHash)).toEqual(
      Buffer.from(await sha256(body.refresh_token))
    );
    expect(Buffer.from(stored.proof.jkt)).toEqual(key.thumbprint);
    expect(publisher.batches).toEqual([[]]);

    const verified = await verifyAt(
      body.access_token,
      KILO_API_AUDIENCE,
      KILO_API_HOME_WIDGET_SCOPE
    );
    if (!verified.ok || verified.credential !== 'access_token') {
      throw new Error(`refused: ${verified.ok ? verified.credential : verified.reason}`);
    }
    expect(verified.claims).toMatchObject({
      aud: KILO_API_AUDIENCE,
      scope: KILO_API_HOME_WIDGET_SCOPE,
      client_id: 'kilo-mobile',
      sub: SUBJECT,
      sid: widgetGrantId,
    });
    expect(verified.claims.exp - verified.claims.iat).toBe(600);
    expect(verified.caller).toEqual({
      kind: 'user',
      subject: SUBJECT,
      clientId: 'kilo-mobile',
      org: null,
      sessionId: widgetGrantId,
      actor: null,
    });
  });

  it('binds the widget to the organization the request names, as the org claim', async () => {
    const key = await dpopKey();
    const grants = fakeGrants({ exchangeHomeWidget: async input => issued(input) });
    const response = await call(
      await exchangeRequest(key, appRefreshToken(), {
        org: ORG,
        resource: 'urn:kilo:service:kilo-api',
        requested_token_type: UTS_ACCESS_TOKEN_TYPE_URN,
      }),
      onDeps(grants)
    );
    expect(response.status).toBe(200);
    const body = HomeWidgetGrantResponseSchema.parse(await response.json());
    expect((grants.calls[0].input as HomeWidgetExchangeInput).orgId).toBe(ORG);
    const verified = await verifyAt(
      body.access_token,
      KILO_API_AUDIENCE,
      KILO_API_HOME_WIDGET_SCOPE
    );
    expect(verified).toMatchObject({ ok: true, caller: { kind: 'user', org: ORG } });
  });
});

describe('home-widget exchange: refresh and re-exchange', () => {
  it('refreshes the widget grant with the ordinary refresh grant, for the widget scope only', async () => {
    const key = await dpopKey();
    const widgetGrantId = crypto.randomUUID();
    const widgetToken = firstPartyRefreshToken(widgetGrantId, randomCredential());
    const grants = fakeGrants({
      refreshFirstParty: async () => ({
        outcome: 'issued',
        ...minted({ subjectId: SUBJECT, scopes: [KILO_API_HOME_WIDGET_SCOPE] }),
      }),
    });
    const response = await call(
      formRequest(
        '/token',
        { grant_type: 'refresh_token', client_id: 'kilo-mobile', refresh_token: widgetToken },
        { DPoP: await dpopProof(key) }
      ),
      onDeps(grants)
    );
    expect(response.status).toBe(200);
    const body = TokenResponseSchema.parse(await response.json());
    expect(body.refresh_token).toBeUndefined();
    const refresh = grants.calls[0].input as FirstPartyRefreshInput;
    expect(refresh.grantId).toBe(widgetGrantId);
    const verified = await verifyAt(
      body.access_token,
      KILO_API_AUDIENCE,
      KILO_API_HOME_WIDGET_SCOPE
    );
    expect(verified).toMatchObject({ ok: true, caller: { sessionId: widgetGrantId } });
  });

  it('publishes the replaced widget grant of a second exchange, so its tokens stop', async () => {
    const key = await dpopKey();
    const appToken = appRefreshToken();
    const first = fakeGrants({ exchangeHomeWidget: async input => issued(input) });
    const firstBody = HomeWidgetGrantResponseSchema.parse(
      await (await call(await exchangeRequest(key, appToken), onDeps(first))).json()
    );
    const replaced = grantIdOfFirstPartyRefreshToken(firstBody.refresh_token);
    if (replaced === null) throw new Error('no widget grant id');

    const second = fakeGrants({ exchangeHomeWidget: async input => issued(input, [replaced]) });
    const publisher = recordingPublisher();
    const response = await call(
      await exchangeRequest(key, appToken),
      onDeps(second, { publish: publisher.publish })
    );
    expect(response.status).toBe(200);
    const secondBody = HomeWidgetGrantResponseSchema.parse(await response.json());
    expect(secondBody.refresh_token).not.toBe(firstBody.refresh_token);
    expect(publisher.batches.map(batch => batch.map(entry => entry.id))).toEqual([[replaced]]);

    const revokedIds = publisher.batches.flat().map(entry => entry.id);
    expect(
      await verifyAt(
        firstBody.access_token,
        KILO_API_AUDIENCE,
        KILO_API_HOME_WIDGET_SCOPE,
        revokedIds
      )
    ).toMatchObject({ ok: false, status: 401, reason: 'revoked_session' });
    expect(
      await verifyAt(
        secondBody.access_token,
        KILO_API_AUDIENCE,
        KILO_API_HOME_WIDGET_SCOPE,
        revokedIds
      )
    ).toMatchObject({ ok: true });
  });

  it('answers 200 when the replaced grant could not be published: the backfill adds it', async () => {
    const key = await dpopKey();
    const grants = fakeGrants({
      exchangeHomeWidget: async input => issued(input, [crypto.randomUUID()]),
    });
    const response = await call(
      await exchangeRequest(key, appRefreshToken()),
      onDeps(grants, { publish: recordingPublisher('unpublished').publish })
    );
    expect(response.status).toBe(200);
  });
});

describe('home-widget exchange: revoke and audience', () => {
  it('ends access once the widget grant is revoked: its feed entry refuses its tokens', async () => {
    const key = await dpopKey();
    const grants = fakeGrants({ exchangeHomeWidget: async input => issued(input) });
    const body = HomeWidgetGrantResponseSchema.parse(
      await (await call(await exchangeRequest(key, appRefreshToken()), onDeps(grants))).json()
    );
    const widgetGrantId = grantIdOfFirstPartyRefreshToken(body.refresh_token);
    if (widgetGrantId === null) throw new Error('no widget grant id');

    const revoking = fakeGrants({
      revoke: async () => ({ outcome: 'revoked', feedEntries: [grantEntry(widgetGrantId)] }),
    });
    const publisher = recordingPublisher();
    const revoked = await call(
      formRequest('/revoke', { token: body.refresh_token, client_id: 'kilo-mobile' }),
      onDeps(revoking, { publish: publisher.publish })
    );
    expect(revoked.status).toBe(200);
    expect(Buffer.from((revoking.calls[0].input as RevokeInput).tokenHash)).toEqual(
      Buffer.from(await sha256(body.refresh_token))
    );
    const published = publisher.batches.flat().map(entry => entry.id);
    expect(published).toEqual([widgetGrantId]);

    expect(
      await verifyAt(body.access_token, KILO_API_AUDIENCE, KILO_API_HOME_WIDGET_SCOPE, published)
    ).toMatchObject({ ok: false, status: 401, error: 'invalid_token', reason: 'revoked_session' });
  });

  it('is refused by a verifier of another audience, and by a Kilo API route of another scope', async () => {
    const key = await dpopKey();
    const grants = fakeGrants({ exchangeHomeWidget: async input => issued(input) });
    const body = HomeWidgetGrantResponseSchema.parse(
      await (await call(await exchangeRequest(key, appRefreshToken()), onDeps(grants))).json()
    );
    expect(
      await verifyAt(body.access_token, KILO_GATEWAY_AUDIENCE, KILO_GATEWAY_INFERENCE_SCOPE)
    ).toMatchObject({ ok: false, status: 403, error: 'insufficient_scope' });
    expect(
      await verifyAt(body.access_token, KILO_API_AUDIENCE, 'kilo-api:profile.read')
    ).toMatchObject({ ok: false, status: 403, error: 'insufficient_scope' });
  });
});

describe('home-widget exchange: refusals before the statement', () => {
  it('is not offered while the switch is off, and runs no statement', async () => {
    const grants = fakeGrants();
    const response = await call(
      await exchangeRequest(await dpopKey(), appRefreshToken()),
      oauthDeps(grants.access)
    );
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_request');
    expect(grants.calls).toEqual([]);
  });

  it.each([
    ['another first-party client', { client_id: 'kilo-cli' }, 400, 'unauthorized_client'],
    [
      'a third-party client',
      { client_id: 'https://client.example.com/oauth/metadata.json' },
      400,
      'unauthorized_client',
    ],
    ['an unknown client', { client_id: 'kilo-unknown' }, 401, 'invalid_client'],
    [
      'a refresh token as the requested type',
      { requested_token_type: UTS_REFRESH_TOKEN_TYPE_URN },
      400,
      'invalid_request',
    ],
    [
      'an actor token',
      { actor_token: 'x', actor_token_type: UTS_ACCESS_TOKEN_TYPE_URN },
      400,
      'invalid_request',
    ],
    ['an audience parameter', { audience: KILO_API_AUDIENCE }, 400, 'invalid_request'],
    ['another mobile scope', { scope: 'notifications:badges.read' }, 400, 'invalid_scope'],
    [
      'a scope the mobile app may not hold',
      { scope: 'kilo-api:profile.read' },
      400,
      'invalid_scope',
    ],
    [
      'two scopes',
      { scope: `${KILO_API_HOME_WIDGET_SCOPE} notifications:badges.read` },
      400,
      'invalid_scope',
    ],
    [
      'another service as the resource',
      { resource: 'urn:kilo:service:kilo-gateway' },
      400,
      'invalid_target',
    ],
    ['a malformed organization', { org: 'not-an-org' }, 400, 'invalid_request'],
    [
      'a subject that is not a refresh grant',
      { subject_token: randomCredential() },
      400,
      'invalid_grant',
    ],
  ] as const)('refuses %s without a statement', async (_name, extra, status, error) => {
    const grants = fakeGrants();
    const response = await call(
      await exchangeRequest(await dpopKey(), appRefreshToken(), extra),
      onDeps(grants)
    );
    expect(response.status).toBe(status);
    expect(await errorOf(response)).toBe(error);
    expect(grants.calls).toEqual([]);
  });

  it('refuses a request without a DPoP proof without a statement', async () => {
    const grants = fakeGrants();
    const request = formRequest('/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: 'kilo-mobile',
      subject_token: appRefreshToken(),
      subject_token_type: UTS_REFRESH_TOKEN_TYPE_URN,
      scope: KILO_API_HOME_WIDGET_SCOPE,
    });
    const response = await call(request, onDeps(grants));
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe('invalid_dpop_proof');
    expect(grants.calls).toEqual([]);
  });

  it('refuses a request that names no scope without a statement', async () => {
    const grants = fakeGrants();
    const request = formRequest(
      '/token',
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        client_id: 'kilo-mobile',
        subject_token: appRefreshToken(),
        subject_token_type: UTS_REFRESH_TOKEN_TYPE_URN,
      },
      { DPoP: await dpopProof(await dpopKey()) }
    );
    const response = await call(request, onDeps(grants));
    expect(await errorOf(response)).toBe('invalid_scope');
    expect(grants.calls).toEqual([]);
  });
});

describe('home-widget exchange: statement outcomes', () => {
  it.each([
    ['invalid_grant', 400, 'invalid_grant'],
    ['dpop_mismatch', 400, 'invalid_grant'],
    ['dpop_replay', 400, 'invalid_dpop_proof'],
    ['invalid_scope', 400, 'invalid_scope'],
    ['org_denied', 400, 'invalid_grant'],
  ] as const)(
    'answers %s as %i %s, with nothing signed or published',
    async (outcome, status, error) => {
      const grants = fakeGrants({ exchangeHomeWidget: async () => ({ outcome }) });
      const publisher = recordingPublisher();
      const response = await call(
        await exchangeRequest(await dpopKey(), appRefreshToken()),
        onDeps(grants, { publish: publisher.publish })
      );
      expect(response.status).toBe(status);
      expect(await errorOf(response)).toBe(error);
      expect(publisher.batches).toEqual([]);
    }
  );

  it('answers the hourly limit as 429 slow_down with the wait the statement names', async () => {
    const grants = fakeGrants({
      exchangeHomeWidget: async () => ({ outcome: 'rate_limited', retryAfterSeconds: 1234 }),
    });
    const response = await call(
      await exchangeRequest(await dpopKey(), appRefreshToken()),
      onDeps(grants)
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('1234');
    expect(await errorOf(response)).toBe('slow_down');
  });

  it.each([
    ['retryable', 503, 'temporarily_unavailable'],
    ['permanent', 500, 'server_error'],
  ] as const)('answers a %s store failure as %i', async (failure, status, error) => {
    const grants = fakeGrants({
      exchangeHomeWidget: async () => {
        throw storeFailure(failure);
      },
    });
    const response = await call(
      await exchangeRequest(await dpopKey(), appRefreshToken()),
      onDeps(grants)
    );
    expect(response.status).toBe(status);
    expect(await errorOf(response)).toBe(error);
  });
});
