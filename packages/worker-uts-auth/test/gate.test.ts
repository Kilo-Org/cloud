import { describe, expect, it } from 'vitest';
import {
  createUtsUserGate,
  userBearerAcceptance,
  userBearerFamily,
  type UserBearerDecision,
  type UserBearerEnv,
} from '../src/index';
import {
  FIXTURE_BLOCKED_SUBJECT,
  FIXTURE_CLIENT,
  FIXTURE_REVOKED_SESSION,
  FIXTURE_REVOKED_SUBJECT,
  createUtsFixture,
  fixtureScopeRegistry,
  type FixtureClaims,
  type UtsFixture,
} from '../src/testing';

const AUDIENCE = 'example-service';
const READ = `${AUDIENCE}:things.read`;
const WRITE = `${AUDIENCE}:things.write`;
const ORG = `${AUDIENCE}:org-things.write`;
// A legacy HS256 Kilo JWT shape; the gate reads only its header.
const LEGACY_TOKEN = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).replace(/=+$/, '')}.e30.c2ln`;

async function setup(mode = 'legacy-and-uts') {
  const fixture = await createUtsFixture();
  const gate = createUtsUserGate({
    audience: AUDIENCE,
    resourceOriginOf: environment =>
      environment === 'development' ? 'https://example.kiloapps.io' : null,
    routes: {
      read: { scope: READ, requiresSession: true, org: 'forbidden' },
      write: { scope: WRITE, requiresSession: true, org: 'forbidden' },
      org: { scope: ORG, requiresSession: true, org: 'required' },
    },
    scopeRegistry: fixtureScopeRegistry({
      [READ]: { allowedClients: [FIXTURE_CLIENT] },
      [WRITE]: { allowedClients: [FIXTURE_CLIENT] },
      [ORG]: { allowedClients: [FIXTURE_CLIENT], orgMember: true },
    }),
  });
  const env: UserBearerEnv = { mode, environment: 'development', feed: fixture.feed };
  const pending: Promise<unknown>[] = [];
  const decide = async (
    token: string | null,
    route: 'read' | 'write' | 'org' = 'read',
    overrides: Partial<UserBearerEnv> = {},
    requestOrg?: string
  ) => {
    const decision = await gate.decide(
      token,
      { ...env, ...overrides },
      route,
      promise => pending.push(promise),
      requestOrg
    );
    await Promise.allSettled(pending);
    return decision;
  };
  return { fixture, gate, env, decide };
}

async function refusal(decision: Promise<UserBearerDecision>) {
  const settled = await decision;
  if (settled.kind !== 'refused') throw new Error(`expected a refusal, got ${settled.kind}`);
  const text = await settled.response.text();
  return {
    status: settled.response.status,
    reason: settled.reason,
    body: text === '' ? null : (JSON.parse(text) as { error: string }),
    headers: settled.response.headers,
  };
}

const read = (fixture: UtsFixture, claims: Partial<FixtureClaims> = {}) =>
  fixture.mint({ aud: AUDIENCE, scope: READ, ...claims });

describe('accept mode', () => {
  it('is a closed set whose unset value is legacy-only', () => {
    expect(userBearerAcceptance(undefined)).toEqual({ legacy: true, uts: false });
    expect(userBearerAcceptance('')).toEqual({ legacy: true, uts: false });
    expect(userBearerAcceptance('legacy-only')).toEqual({ legacy: true, uts: false });
    expect(userBearerAcceptance('legacy-and-uts')).toEqual({ legacy: true, uts: true });
    expect(userBearerAcceptance('uts-only')).toEqual({ legacy: false, uts: true });
    expect(userBearerAcceptance('disabled')).toEqual({ legacy: false, uts: false });
    for (const value of ['LEGACY-ONLY', 'uts', 'true', 'legacy-only ', 'constructor']) {
      expect(userBearerAcceptance(value)).toBeNull();
    }
  });

  it('refuses every bearer with 500 when the mode is outside the set', async () => {
    const { fixture, decide } = await setup('legacy_and_uts');
    expect((await refusal(decide(await read(fixture)))).status).toBe(500);
    expect((await refusal(decide(LEGACY_TOKEN))).status).toBe(500);
    expect((await refusal(decide(null))).status).toBe(500);
  });
});

describe('bearer family', () => {
  it('reads the family from the token shape alone', async () => {
    const fixture = await createUtsFixture();
    expect(userBearerFamily(await read(fixture))).toBe('uts');
    expect(userBearerFamily(`kilo_pat_${'a'.repeat(49)}`)).toBe('uts');
    expect(userBearerFamily(LEGACY_TOKEN)).toBe('legacy');
    expect(userBearerFamily('not-a-jwt')).toBe('legacy');
    expect(userBearerFamily('!!.e30.c2ln')).toBe('legacy');
    const eddsaWithoutType = `${btoa(JSON.stringify({ alg: 'EdDSA' }))}.e30.c2ln`;
    expect(userBearerFamily(eddsaWithoutType)).toBe('legacy');
  });
});

describe('modes route each family to one verifier', () => {
  it('legacy-only leaves every bearer to the legacy path and calls no feed', async () => {
    const { fixture, decide } = await setup('legacy-only');
    expect(await decide(await read(fixture))).toEqual({ kind: 'legacy' });
    expect(await decide(LEGACY_TOKEN)).toEqual({ kind: 'legacy' });
    expect(await decide(null)).toEqual({ kind: 'legacy' });
    expect(fixture.calls).toEqual({ head: 0, list: 0, bootstrap: 0, jwks: 0 });
  });

  it('legacy-and-uts sends a legacy bearer and a missing one to the legacy path', async () => {
    const { decide } = await setup();
    expect(await decide(LEGACY_TOKEN)).toEqual({ kind: 'legacy' });
    expect(await decide(null)).toEqual({ kind: 'legacy' });
  });

  it('uts-only refuses a legacy bearer, and a missing one with a challenge', async () => {
    const { fixture, decide } = await setup('uts-only');
    const legacy = await refusal(decide(LEGACY_TOKEN));
    expect([legacy.status, legacy.reason]).toEqual([401, 'legacy_not_accepted']);
    expect(legacy.headers.get('cache-control')).toBe('no-store');
    expect(legacy.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", resource_metadata="https://example.kiloapps.io/.well-known/oauth-protected-resource"'
    );
    const missing = await refusal(decide(null));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://example.kiloapps.io/.well-known/oauth-protected-resource"'
    );
    // The mode refusal reads configuration only: it builds no verifier and calls no feed.
    expect(fixture.calls).toEqual({ head: 0, list: 0, bootstrap: 0, jwks: 0 });
  });

  it('disabled refuses both families with a challenge that names no unserved metadata', async () => {
    const { fixture, decide } = await setup('disabled');
    expect((await refusal(decide(LEGACY_TOKEN))).status).toBe(401);
    const uts = await refusal(decide(await read(fixture)));
    expect(uts.status).toBe(401);
    expect(uts.headers.get('cache-control')).toBe('no-store');
    expect(uts.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    expect(fixture.calls).toEqual({ head: 0, list: 0, bootstrap: 0, jwks: 0 });
  });
});

describe('a UTS user token', () => {
  it('admits the route scope and returns the caller and verified claims', async () => {
    const { fixture, decide } = await setup();
    const decision = await decide(await read(fixture, { sub: 'user-1' }));
    if (decision.kind !== 'uts') throw new Error(`expected uts, got ${decision.kind}`);
    expect(decision.caller).toEqual({
      userId: 'user-1',
      clientId: FIXTURE_CLIENT,
      org: null,
      sessionId: 'uts-fixture-live-session',
    });
    expect(decision.claims.scope).toBe(READ);
    expect(decision.claims.exp - decision.claims.iat).toBe(600);
  });

  it('builds the verifier once and serves later requests from its copies', async () => {
    const { fixture, decide } = await setup();
    for (let i = 0; i < 3; i++) expect((await decide(await read(fixture))).kind).toBe('uts');
    expect(fixture.calls.bootstrap).toBe(1);
  });

  it.each<[string, Partial<FixtureClaims>, number, string]>([
    [
      'another audience',
      { aud: 'other-service', scope: 'other-service:things.read' },
      403,
      'audience',
    ],
    ['another scope of this audience', { scope: WRITE }, 403, 'scope_mismatch'],
    ['an unregistered scope', { scope: `${AUDIENCE}:unknown.read` }, 403, 'scope_unknown'],
    ['the STS issuer', { iss: 'https://sts.kiloapps.io' }, 401, 'issuer'],
    ['the production UTS issuer', { iss: 'https://uts.kiloapps.io' }, 401, 'issuer'],
    ['an expired token', { iat: 1_000, exp: 1_600 }, 401, 'expired'],
    ['no session', { sid: undefined }, 401, 'session_required'],
    [
      'a bot token, which names no session',
      { sid: undefined, bot_user: true, client_id: 'auto-routing-benchmark' },
      401,
      'session_required',
    ],
    ['a revoked session', { sid: FIXTURE_REVOKED_SESSION }, 401, 'revoked_session'],
    ['a revoked subject', { sub: FIXTURE_REVOKED_SUBJECT }, 401, 'revoked_subject'],
    ['a blocked account', { sub: FIXTURE_BLOCKED_SUBJECT }, 401, 'blocked_account'],
    ['a delegated actor', { act: { sub: 'sandbox-1' } }, 403, 'delegation'],
    ['an organization on a personal route', { org: 'org-1' }, 403, 'org_forbidden'],
    ['a client the scope does not list', { client_id: 'kilo-mobile' }, 403, 'client_not_allowed'],
    ['another environment in the env claim', { env: 'production' }, 401, 'environment'],
  ])('refuses %s', async (_name, claims, status, reason) => {
    const { fixture, decide } = await setup();
    const refused = await refusal(decide(await read(fixture, claims)));
    expect([refused.status, refused.reason]).toEqual([status, reason]);
    expect(refused.headers.get('cache-control')).toBe('no-store');
  });

  it.each<[string, Partial<FixtureClaims>, string]>([
    ['a delegated actor', { act: { sub: 'sandbox-1' } }, 'delegation'],
    ['a client the scope does not list', { client_id: 'kilo-mobile' }, 'client_not_allowed'],
  ])('refuses %s with insufficient_scope naming the route scope', async (_name, claims, reason) => {
    const { fixture, decide } = await setup();
    const refused = await refusal(decide(await read(fixture, claims)));
    expect([refused.status, refused.reason]).toEqual([403, reason]);
    expect(refused.body).toEqual({ error: 'insufficient_scope', scope: READ });
    expect(refused.headers.get('www-authenticate')).toBe(
      `Bearer error="insufficient_scope", scope="${READ}", resource_metadata="https://example.kiloapps.io/.well-known/oauth-protected-resource"`
    );
  });

  it('refuses a token that outlives the scope registry lifetime', async () => {
    const { fixture, decide } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const refused = await refusal(decide(await read(fixture, { iat: now, exp: now + 601 })));
    expect([refused.status, refused.reason]).toEqual([401, 'lifetime']);
  });

  it('refuses a token signed with a key the key set does not hold', async () => {
    const { fixture, decide } = await setup();
    const token = await fixture.mintWithUnknownKey({ aud: AUDIENCE, scope: READ });
    expect((await refusal(decide(token))).status).toBe(401);
  });

  it('refuses a PAT, which no Worker user route accepts', async () => {
    const { decide } = await setup();
    const refused = await refusal(decide(`kilo_pat_${'A'.repeat(49)}`));
    expect(refused.status).toBe(401);
  });

  it('refuses a token without an env claim', async () => {
    const { fixture, decide } = await setup();
    const refused = await refusal(decide(await read(fixture, { env: undefined })));
    expect([refused.status, refused.body?.error]).toEqual([401, 'invalid_token']);
  });

  it('needs the token organization on an org route, equal to the one the request names', async () => {
    const { fixture, decide } = await setup();
    const mint = (org?: string) => fixture.mint({ aud: AUDIENCE, scope: ORG, org });
    const admitted = await decide(await mint('org-1'), 'org', {}, 'org-1');
    expect(admitted.kind === 'uts' && admitted.caller.org).toBe('org-1');
    expect((await decide(await mint('org-1'), 'org')).kind).toBe('uts');
    const other = await refusal(decide(await mint('org-1'), 'org', {}, 'org-2'));
    expect([other.status, other.reason]).toEqual([403, 'org_mismatch']);
    // With a request organization the library refuses a token without one.
    const none = await refusal(decide(await mint(), 'org', {}, 'org-1'));
    expect([none.status, none.reason]).toEqual([403, 'org_mismatch']);
    // Without one, the route itself still needs the token's organization.
    const unnamed = await refusal(decide(await mint(), 'org'));
    expect([unnamed.status, unnamed.reason]).toEqual([403, 'org_required']);
    // An empty request organization is still a request organization, never a personal route.
    const empty = await refusal(decide(await mint('org-1'), 'org', {}, ''));
    expect([empty.status, empty.reason]).toEqual([403, 'org_mismatch']);
  });
});

describe('dependencies and configuration fail closed', () => {
  it('answers 503 with Retry-After while a cold instance cannot reach the feed', async () => {
    const { fixture, decide } = await setup();
    fixture.setAvailable(false);
    const refused = await refusal(decide(await read(fixture)));
    expect(refused.status).toBe(503);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it.each<[string, Partial<UserBearerEnv>, string]>([
    ['an unmapped environment', { environment: 'preview' }, 'no_uts_environment'],
    ['a missing environment', { environment: undefined }, 'no_uts_environment'],
    ['an environment with no resource origin', { environment: 'staging' }, 'no_resource_origin'],
    ['a missing feed binding', { feed: undefined }, 'no_feed_binding'],
  ])('answers 500 for %s', async (_name, overrides, reason) => {
    const { fixture, decide } = await setup();
    const refused = await refusal(decide(await read(fixture), 'read', overrides));
    expect([refused.status, refused.reason]).toEqual([500, reason]);
    expect(fixture.calls.bootstrap).toBe(0);
  });

  it('still sends a legacy bearer to the legacy path when UTS is misconfigured', async () => {
    const { decide } = await setup();
    expect(await decide(LEGACY_TOKEN, 'read', { feed: undefined })).toEqual({ kind: 'legacy' });
  });
});

describe('protected-resource metadata', () => {
  it('is 404 while the deployment accepts no UTS token', async () => {
    const { gate, env } = await setup('legacy-only');
    expect(gate.metadata(env).status).toBe(404);
    expect(gate.metadata({ ...env, mode: 'uts-only', feed: undefined }).status).toBe(404);
  });

  it('names the resource, the environment issuer and the route scopes', async () => {
    const { gate, env } = await setup();
    const response = gate.metadata(env);
    expect(await response.json()).toEqual({
      resource: 'https://example.kiloapps.io',
      authorization_servers: ['http://localhost:8800'],
      bearer_methods_supported: ['header'],
      scopes_supported: [READ, WRITE, ORG],
    });
  });

  it('takes the resource from the phase 3 origin table by default', async () => {
    const fixture = await createUtsFixture('production');
    const gate = createUtsUserGate({
      audience: 'kilo-chat',
      routes: { chat: { scope: 'kilo-chat:chat.use', requiresSession: true, org: 'forbidden' } },
    });
    const env = { mode: 'uts-only', environment: 'production', feed: fixture.feed };
    expect(await gate.metadata(env).json()).toMatchObject({
      resource: 'https://chat.kiloapps.io',
      authorization_servers: ['https://uts.kiloapps.io'],
    });
  });
});

describe('gate configuration', () => {
  it('refuses a route scope of another audience', () => {
    const route = { scope: 'other:things.read', requiresSession: true, org: 'forbidden' } as const;
    expect(() => createUtsUserGate({ audience: AUDIENCE, routes: { r: route } })).toThrow(
      /not a scope of/
    );
  });
});
