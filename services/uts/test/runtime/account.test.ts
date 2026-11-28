import { Buffer } from 'node:buffer';
import {
  BotKeyListSchema,
  CreatedBotKeySchema,
  CreatedPatSchema,
  PatListSchema,
  UTS_BOT_KEYS_MANAGE_SCOPE,
  UTS_PATS_MANAGE_SCOPE,
  UtsPublicJwkSchema,
} from '@kilocode/uts-contracts';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_KEYS_FRESH_MS,
  ACCESS_TOKEN_KEYS_RECHECK_MS,
  type AccessTokenKeyCopy,
  type AccessTokenKeys,
  checkAccountBearer,
  shardAccessTokenKeys,
} from '../../src/account/bearer';
import { readKeySetShard, readThroughIsolateShard } from '../../src/signer-keys';
import {
  type AccountDeps,
  type CredentialNotice,
  handleAccountRequest,
} from '../../src/account/routes';
import type { AccountAccess, AccountStore } from '../../src/account/store';
import type { FeedEntry } from '../../src/revocation/entries';
import type { SignableClaims } from '../../src/keys/claims';
import { getSignerStub } from '../../src/dos/stubs';
import { isWellFormedSecret, lastFour } from '../../src/pat/format';
import { recordingPublisher, storeFailure } from './oauth-support';
import { claims } from './support';
import { config, env } from './test-env';

/**
 * The account API against the real signer objects and key-set shards of the test pool, with a
 * recording account store in place of the identity store (test/db runs the statements).
 */

const ACCOUNT = 'oauth/account-runtime';
const GRANT = crypto.randomUUID();
const ORG = crypto.randomUUID();

/** An access token for the `uts` audience, signed by signer 3. */
async function accessToken(overrides: Partial<SignableClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const result = await getSignerStub(env, config, 3).sign(
    claims({
      aud: 'uts',
      scope: UTS_PATS_MANAGE_SCOPE,
      sub: ACCOUNT,
      sid: GRANT,
      iat: now,
      exp: now + 600,
      ...overrides,
    })
  );
  if (result.status !== 'signed') throw new Error(`signing failed: ${result.status}`);
  return result.token;
}

type Call = { method: keyof AccountStore; input: unknown };

/** An account store that answers with `implementation` and records every call. */
function fakeAccount(implementation: Partial<AccountStore>) {
  const calls: Call[] = [];
  function recorded<Input, Output>(
    method: keyof AccountStore,
    run: ((input: Input) => Promise<Output>) | undefined
  ): (input: Input) => Promise<Output> {
    return async input => {
      calls.push({ method, input });
      if (run === undefined) throw new Error(`unexpected ${method} call`);
      return await run(input);
    };
  }
  const store: AccountStore = {
    createPat: recorded('createPat', implementation.createPat),
    listPats: recorded('listPats', implementation.listPats),
    revokePat: recorded('revokePat', implementation.revokePat),
    createBotKey: recorded('createBotKey', implementation.createBotKey),
    listBotKeys: recorded('listBotKeys', implementation.listBotKeys),
    revokeBotKey: recorded('revokeBotKey', implementation.revokeBotKey),
    keepBotKey: recorded('keepBotKey', implementation.keepBotKey),
  };
  const access: AccountAccess = work => work(store);
  return { access, calls };
}

function deps(
  account: AccountAccess,
  overrides: Partial<AccountDeps> = {}
): AccountDeps & { waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    config,
    account,
    keys: shardAccessTokenKeys(env, config),
    notices: null,
    publish: recordingPublisher().publish,
    context: { waitUntil: promise => waited.push(promise) },
    nowSeconds: () => Math.floor(Date.now() / 1000),
    waited,
    ...overrides,
  };
}

function request(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.json !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${config.endpoints.issuer}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json === undefined ? init.body : JSON.stringify(init.json),
  });
}

async function call(req: Request, accountDeps: AccountDeps): Promise<Response> {
  const response = await handleAccountRequest(req, new URL(req.url).pathname, accountDeps);
  if (response === null) throw new Error('no account route answered');
  return response;
}

const created = { id: crypto.randomUUID(), createdAt: new Date(), expiresAt: new Date() };

/** The feed entry a PAT or bot key revoke returns (a 15-minute entry). */
function credentialEntry(kind: 'pat' | 'bot_key', id: string): FeedEntry {
  const now = Date.now();
  return { kind, id, revokedBefore: null, revokedAt: now, expiresAt: now + 15 * 60_000 };
}

describe('account API authentication', () => {
  const unused = fakeAccount({});

  it('answers 401 with the resource metadata when no credential is sent', async () => {
    const response = await call(request('/account/pats'), deps(unused.access));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="${config.endpoints.issuer}/.well-known/oauth-protected-resource"`
    );
  });

  it('refuses a PAT, a malformed value, a token for another audience, and one without sid', async () => {
    const tokens = [
      'kilo_pat_' + 'A'.repeat(49),
      'not-a-token',
      await accessToken({ aud: 'gateway', scope: 'gateway:models.read' }),
      await accessToken({ sid: undefined }),
    ];
    for (const token of tokens) {
      const response = await call(request('/account/pats', { token }), deps(unused.access));
      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain('error="invalid_token"');
    }
    expect(unused.calls).toEqual([]);
  });

  it('refuses a token past its expiry and skew, and one whose signature does not verify', async () => {
    const token = await accessToken();
    const later = Math.floor(Date.now() / 1000) + 600 + 61;
    const expired = await call(
      request('/account/pats', { token }),
      deps(unused.access, { nowSeconds: () => later })
    );
    expect(expired.status).toBe(401);
    const [header, payload] = token.split('.');
    const forged = `${header}.${payload}.${Buffer.alloc(64).toString('base64url')}`;
    expect(
      (await call(request('/account/pats', { token: forged }), deps(unused.access))).status
    ).toBe(401);
  });

  it('refuses a token under a kid the key set lacks, and a token of another issuer', async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const kid = `uts-token-03-${await calculateJwkThumbprint(jwk, 'sha256')}`;
    const now = Math.floor(Date.now() / 1000);
    const sign = (issuer: string) =>
      new SignJWT({
        aud: 'uts',
        sub: ACCOUNT,
        client_id: 'kilo-cli',
        jti: crypto.randomUUID(),
        scope: UTS_PATS_MANAGE_SCOPE,
        sid: GRANT,
        env: 'development',
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid })
        .setIssuer(issuer)
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(privateKey);

    // The real key-set shard holds no such kid.
    expect(await shardAccessTokenKeys(env, config)(kid)).toEqual({ status: 'unknown' });
    const unknownKid = await call(
      request('/account/pats', { token: await sign(config.endpoints.issuer) }),
      deps(unused.access)
    );
    expect(unknownKid.status).toBe(401);

    // With the key known, the right issuer passes and another issuer is refused.
    const key = UtsPublicJwkSchema.parse({ ...jwk, kid, alg: 'EdDSA', use: 'sig' });
    const keys: AccessTokenKeys = async wanted =>
      wanted === kid ? { status: 'found', key } : { status: 'unknown' };
    const listing = fakeAccount({ listPats: async () => ({ outcome: 'listed', pats: [] }) });
    const known = await call(
      request('/account/pats', { token: await sign(config.endpoints.issuer) }),
      deps(listing.access, { keys })
    );
    expect(known.status).toBe(200);
    const otherIssuer = await call(
      request('/account/pats', { token: await sign('https://uts.kiloapps.io') }),
      deps(unused.access, { keys })
    );
    expect(otherIssuer.status).toBe(401);
    expect(unused.calls).toEqual([]);
  });

  it('serves only scopes the registry marks as session-bound', async () => {
    const token = await accessToken({ scope: 'uts:probe.read' });
    for (const scope of ['uts:probe.read', 'kilo-api:profile.read', 'gateway:unknown.read']) {
      await expect(
        checkAccountBearer(`Bearer ${token}`, scope, config, async () => ({ status: 'unknown' }), 0)
      ).rejects.toThrow('is not registered as session-bound');
    }
  });

  it('refuses a client the scope registry does not allow for the route', async () => {
    for (const clientId of ['https://client.example.com/app', 'kilo-mobile']) {
      const response = await call(
        request('/account/pats', { token: await accessToken({ client_id: clientId }) }),
        deps(unused.access)
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'access_denied' });
    }
    expect(unused.calls).toEqual([]);
  });

  it('serves a kilo-web token as its subject and the browser session its sid names, on both routes', async () => {
    const webSession = crypto.randomUUID();
    const store = fakeAccount({
      listPats: async () => ({ outcome: 'listed', pats: [] }),
      listBotKeys: async () => ({ outcome: 'listed', botKeys: [] }),
    });
    const pats = await call(
      request('/account/pats', {
        token: await accessToken({ client_id: 'kilo-web', sid: webSession }),
      }),
      deps(store.access)
    );
    expect(pats.status).toBe(200);
    const keys = await call(
      request(`/account/orgs/${ORG}/bot-keys`, {
        token: await accessToken({
          client_id: 'kilo-web',
          sid: webSession,
          scope: UTS_BOT_KEYS_MANAGE_SCOPE,
        }),
      }),
      deps(store.access)
    );
    expect(keys.status).toBe(200);
    expect(store.calls).toEqual([
      { method: 'listPats', input: { accountId: ACCOUNT, grantId: webSession, orgId: null } },
      { method: 'listBotKeys', input: { accountId: ACCOUNT, grantId: webSession, orgId: ORG } },
    ]);
  });

  it('acts for the kilo-web token subject only: another account’s PAT is not found and its session is not live', async () => {
    const otherAccountPat = crypto.randomUUID();
    const store = fakeAccount({
      // As uts.revoke_pat answers for a PAT of another account (test/db/account.test.ts).
      revokePat: async () => ({ outcome: 'not_found', feedEntries: [] }),
      // As uts.account_session answers for a session of another account.
      createPat: async () => ({ outcome: 'invalid_session' }),
    });
    const token = await accessToken({ client_id: 'kilo-web' });
    const revoked = await call(
      request(`/account/pats/${otherAccountPat}`, { method: 'DELETE', token }),
      deps(store.access)
    );
    expect(revoked.status).toBe(404);
    const created = await call(
      request('/account/pats', {
        method: 'POST',
        token,
        json: { name: 'ci', scope: 'uts:probe.read' },
      }),
      deps(store.access)
    );
    expect(created.status).toBe(401);
    expect(store.calls.map(entry => entry.input)).toMatchObject([
      { accountId: ACCOUNT, grantId: GRANT, patId: otherAccountPat },
      { accountId: ACCOUNT, grantId: GRANT },
    ]);
  });

  it('answers 403 with the needed scope for a token of another scope', async () => {
    const token = await accessToken({ scope: UTS_BOT_KEYS_MANAGE_SCOPE });
    const response = await call(request('/account/pats', { token }), deps(unused.access));
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain(`scope="${UTS_PATS_MANAGE_SCOPE}"`);
  });

  it('reads the key set once per isolate copy, so tokens under an unknown kid cost no Durable Object call each', async () => {
    const { publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    const unknownKid = `uts-token-03-${await calculateJwkThumbprint(await exportJWK(publicKey), 'sha256')}`;
    let reads = 0;
    const read = async () => {
      reads += 1;
      return await readThroughIsolateShard(shard => readKeySetShard(env, config, shard));
    };
    const copy: AccessTokenKeyCopy = { copy: null };
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const keys = shardAccessTokenKeys(env, config, copy, read);
      for (let request = 0; request < 50; request += 1) {
        expect(await keys(unknownKid)).toEqual({ status: 'unknown' });
      }
      const token = await accessToken();
      const kid = String(JSON.parse(atob(token.split('.')[0])).kid);
      expect(await keys(kid)).toMatchObject({ status: 'found' });
      expect(reads).toBe(1);
      // An unknown kid reads again once the copy is past the recheck time, since a signer key
      // can be new; a known kid keeps using the copy until it is past its fresh time.
      clock.mockReturnValue(now + ACCESS_TOKEN_KEYS_RECHECK_MS);
      expect(await keys(kid)).toMatchObject({ status: 'found' });
      expect(reads).toBe(1);
      expect(await keys(unknownKid)).toEqual({ status: 'unknown' });
      expect(reads).toBe(2);
      clock.mockReturnValue(now + ACCESS_TOKEN_KEYS_RECHECK_MS + ACCESS_TOKEN_KEYS_FRESH_MS);
      expect(await keys(kid)).toMatchObject({ status: 'found' });
      expect(reads).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps no copy of a failed key-set read', async () => {
    let reads = 0;
    const keys = shardAccessTokenKeys(env, config, { copy: null }, async () => {
      reads += 1;
      return { status: 'misconfigured' };
    });
    expect(await keys('uts-token-03-x')).toEqual({ status: 'unavailable' });
    expect(await keys('uts-token-03-x')).toEqual({ status: 'unavailable' });
    expect(reads).toBe(2);
  });

  it('answers 503 when no key-set shard answers', async () => {
    const keys: AccessTokenKeys = async () => ({ status: 'unavailable' });
    const response = await call(
      request('/account/pats', { token: await accessToken() }),
      deps(unused.access, { keys })
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
  });
});

describe('PAT routes', () => {
  it('creates a PAT, shows it once, stores only its hash, and sends the notice', async () => {
    const fake = fakeAccount({ createPat: async () => ({ outcome: 'created', ...created }) });
    const notices: CredentialNotice[] = [];
    const accountDeps = deps(fake.access, {
      notices: async notice => {
        notices.push(notice);
      },
    });
    const response = await call(
      request('/account/pats', {
        method: 'POST',
        token: await accessToken(),
        json: { name: 'ci deploy', scope: 'uts:probe.read', expires_in_days: 30 },
      }),
      accountDeps
    );
    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = CreatedPatSchema.parse(await response.json());
    expect(isWellFormedSecret('pat', body.token)).toBe(true);
    expect(body).toMatchObject({
      id: created.id,
      audience: 'uts',
      last_four: lastFour(body.token),
    });
    const [stored] = fake.calls;
    const expectedHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.token))
    );
    expect(stored.input).toMatchObject({
      accountId: ACCOUNT,
      grantId: GRANT,
      scope: 'uts:probe.read',
      orgId: null,
      lifetimeDays: 30,
      tokenHash: expectedHash,
    });
    expect(JSON.stringify(stored.input)).not.toContain(body.token);
    await Promise.all(accountDeps.waited);
    expect(notices).toEqual([
      { kind: 'pat_created', accountId: ACCOUNT, credentialId: created.id },
    ]);
  });

  it('uses 90 days when the request names no lifetime', async () => {
    const fake = fakeAccount({ createPat: async () => ({ outcome: 'created', ...created }) });
    await call(
      request('/account/pats', {
        method: 'POST',
        token: await accessToken(),
        json: { name: 'ci', scope: 'uts:probe.read' },
      }),
      deps(fake.access)
    );
    expect(fake.calls[0].input).toMatchObject({ lifetimeDays: 90 });
  });

  it('answers the RFC 9470 step-up challenge when the gate refuses', async () => {
    const fake = fakeAccount({ createPat: async () => ({ outcome: 'gate_required' }) });
    const response = await call(
      request('/account/pats', {
        method: 'POST',
        token: await accessToken(),
        json: { name: 'ci', scope: 'uts:probe.read' },
      }),
      deps(fake.access)
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toMatch(
      /^Bearer error="insufficient_user_authentication", .*max_age="600"$/
    );
  });

  it('answers 429 once the account created 20 PATs in the hour', async () => {
    const fake = fakeAccount({ createPat: async () => ({ outcome: 'rate_limited' }) });
    const response = await call(
      request('/account/pats', {
        method: 'POST',
        token: await accessToken(),
        json: { name: 'ci', scope: 'uts:probe.read' },
      }),
      deps(fake.access)
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');
    expect(await response.json()).toMatchObject({ error: 'too_many_requests' });
  });

  it('stops reading a body without a length once it passes 4 KB', async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode(' '.repeat(1024)));
      },
    });
    const response = await call(
      new Request(`${config.endpoints.issuer}/account/pats`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: endless,
      }),
      deps(fakeAccount({}).access)
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_description: 'the body is too large' });
    expect(pulls).toBeLessThan(10);
  });

  it.each([
    ['an unknown scope', { name: 'ci', scope: 'gateway:unknown.read' }, 400, 'invalid_scope'],
    ['a credential scope', { name: 'ci', scope: UTS_PATS_MANAGE_SCOPE }, 400, 'invalid_scope'],
    [
      'a lifetime over a year',
      { name: 'ci', scope: 'uts:probe.read', expires_in_days: 366 },
      400,
      'invalid_request',
    ],
    ['an empty name', { name: '  ', scope: 'uts:probe.read' }, 400, 'invalid_request'],
    [
      'an extra field',
      { name: 'ci', scope: 'uts:probe.read', audience: 'gateway' },
      400,
      'invalid_request',
    ],
  ])('refuses %s before any statement', async (_name, json, status, error) => {
    const fake = fakeAccount({});
    const response = await call(
      request('/account/pats', { method: 'POST', token: await accessToken(), json }),
      deps(fake.access)
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(fake.calls).toEqual([]);
  });

  it('refuses a PAT for another organization than the token is bound to', async () => {
    const fake = fakeAccount({});
    const response = await call(
      request('/account/pats', {
        method: 'POST',
        token: await accessToken({ org: ORG }),
        json: { name: 'ci', scope: 'uts:probe.read', org: crypto.randomUUID() },
      }),
      deps(fake.access)
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'org_mismatch' });
  });

  it.each([
    ['invalid_session', 401],
    ['org_denied', 403],
    ['limit_reached', 409],
  ] as const)('answers %s with %i', async (outcome, status) => {
    const fake = fakeAccount({ createPat: async () => ({ outcome }) });
    const response = await call(
      request('/account/pats', {
        method: 'POST',
        token: await accessToken(),
        json: { name: 'ci', scope: 'uts:probe.read' },
      }),
      deps(fake.access)
    );
    expect(response.status).toBe(status);
  });

  it('lists an empty set and a set of PATs', async () => {
    const pat = {
      id: crypto.randomUUID(),
      name: 'ci',
      audience: 'uts',
      scope: 'uts:probe.read',
      org: null,
      last_four: 'abcd',
      created_at: new Date().toISOString(),
      expires_at: new Date().toISOString(),
      last_used_at: null,
    };
    for (const pats of [[], [pat]]) {
      const fake = fakeAccount({ listPats: async () => ({ outcome: 'listed', pats }) });
      const response = await call(
        request('/account/pats', { token: await accessToken() }),
        deps(fake.access)
      );
      expect(response.status).toBe(200);
      expect(PatListSchema.parse(await response.json())).toEqual({ pats });
    }
  });

  it('revokes idempotently, publishes the feed entry, and answers 404 for no such PAT', async () => {
    const entry = credentialEntry('pat', created.id);
    for (const [outcome, feedEntries, status] of [
      ['revoked', [entry], 204],
      ['already_revoked', [entry], 204],
      ['not_found', [], 404],
      ['invalid_session', [], 401],
    ] as const) {
      const fake = fakeAccount({
        revokePat: async () => ({ outcome, feedEntries: [...feedEntries] }),
      });
      const feed = recordingPublisher();
      const response = await call(
        request(`/account/pats/${created.id}`, { method: 'DELETE', token: await accessToken() }),
        deps(fake.access, { publish: feed.publish })
      );
      expect(response.status).toBe(status);
      expect(fake.calls[0].input).toMatchObject({ patId: created.id, grantId: GRANT });
      expect(feed.batches).toEqual(status === 204 ? [[...feedEntries]] : []);
    }
  });

  it('answers 503 when no feed object took the entry, and the retry finds it revoked', async () => {
    const fake = fakeAccount({
      revokePat: async () => ({
        outcome: 'revoked',
        feedEntries: [credentialEntry('pat', created.id)],
      }),
    });
    const feed = recordingPublisher('unpublished');
    const response = await call(
      request(`/account/pats/${created.id}`, { method: 'DELETE', token: await accessToken() }),
      deps(fake.access, { publish: feed.publish })
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(feed.batches).toHaveLength(1);
  });

  it('answers 503 for a retryable store failure and 500 for any other', async () => {
    for (const [failure, status] of [
      ['retryable', 503],
      ['permanent', 500],
    ] as const) {
      const fake = fakeAccount({
        listPats: async () => {
          throw storeFailure(failure);
        },
      });
      const response = await call(
        request('/account/pats', { token: await accessToken() }),
        deps(fake.access)
      );
      expect(response.status).toBe(status);
    }
  });

  it('answers 405 to another method and no route to another path', async () => {
    const fake = fakeAccount({});
    const token = await accessToken();
    expect(
      (await call(request('/account/pats', { method: 'PUT', token }), deps(fake.access))).status
    ).toBe(405);
    expect(
      await handleAccountRequest(request('/account/other'), '/account/other', deps(fake.access))
    ).toBeNull();
  });
});

describe('org bot key routes', () => {
  const botToken = (overrides: Record<string, unknown> = {}) =>
    accessToken({ scope: UTS_BOT_KEYS_MANAGE_SCOPE, ...overrides });

  it('creates a key for the organization in the path', async () => {
    const fake = fakeAccount({ createBotKey: async () => ({ outcome: 'created', ...created }) });
    const response = await call(
      request(`/account/orgs/${ORG}/bot-keys`, {
        method: 'POST',
        token: await botToken(),
        json: { name: 'deploy bot', scope: 'uts:probe.read' },
      }),
      deps(fake.access)
    );
    expect(response.status).toBe(201);
    const body = CreatedBotKeySchema.parse(await response.json());
    expect(isWellFormedSecret('bot_key', body.token)).toBe(true);
    expect(body).toMatchObject({ org: ORG, created_by: ACCOUNT });
    expect(fake.calls[0].input).toMatchObject({ orgId: ORG, accountId: ACCOUNT, lifetimeDays: 90 });
  });

  it('answers 429 once the organization got 20 bot keys in the hour', async () => {
    const fake = fakeAccount({ createBotKey: async () => ({ outcome: 'rate_limited' }) });
    const response = await call(
      request(`/account/orgs/${ORG}/bot-keys`, {
        method: 'POST',
        token: await botToken(),
        json: { name: 'deploy bot', scope: 'uts:probe.read' },
      }),
      deps(fake.access)
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3600');
  });

  it('refuses a member who is no admin, and a token bound to another organization', async () => {
    const fake = fakeAccount({ listBotKeys: async () => ({ outcome: 'not_org_admin' }) });
    expect(
      (
        await call(
          request(`/account/orgs/${ORG}/bot-keys`, { token: await botToken() }),
          deps(fake.access)
        )
      ).status
    ).toBe(403);
    const bound = await call(
      request(`/account/orgs/${ORG}/bot-keys`, {
        token: await botToken({ org: crypto.randomUUID() }),
      }),
      deps(fake.access)
    );
    expect(bound.status).toBe(403);
    expect(await bound.json()).toMatchObject({ error: 'org_mismatch' });
    expect(fake.calls).toHaveLength(1);
  });

  it('lists the live keys of each state', async () => {
    const now = new Date().toISOString();
    const fields = {
      org: ORG,
      name: 'bot',
      audience: 'uts',
      scope: 'uts:probe.read',
      last_four: 'wxyz',
      created_by: ACCOUNT,
      created_at: now,
      expires_at: now,
      last_used_at: null,
    };
    const botKeys = [
      { ...fields, id: crypto.randomUUID(), status: 'active' as const },
      {
        ...fields,
        id: crypto.randomUUID(),
        status: 'flagged' as const,
        flagged_at: now,
        stops_at: now,
      },
      {
        ...fields,
        id: crypto.randomUUID(),
        status: 'kept' as const,
        flagged_at: now,
        kept_by: ACCOUNT,
        kept_at: now,
      },
    ];
    const fake = fakeAccount({ listBotKeys: async () => ({ outcome: 'listed', botKeys }) });
    const response = await call(
      request(`/account/orgs/${ORG}/bot-keys`, { token: await botToken() }),
      deps(fake.access)
    );
    expect(BotKeyListSchema.parse(await response.json())).toEqual({ bot_keys: botKeys });
  });

  it.each([
    ['kept', 204],
    ['not_flagged', 409],
    ['lapsed', 409],
    ['not_found', 404],
    ['not_org_admin', 403],
    ['gate_required', 401],
  ] as const)('answers a keep that is %s with %i', async (outcome, status) => {
    const fake = fakeAccount({ keepBotKey: async () => outcome });
    const keyId = crypto.randomUUID();
    const response = await call(
      request(`/account/orgs/${ORG}/bot-keys/${keyId}/keep`, {
        method: 'POST',
        token: await botToken(),
      }),
      deps(fake.access)
    );
    expect(response.status).toBe(status);
    expect(fake.calls[0].input).toMatchObject({ orgId: ORG, keyId });
  });

  it('revokes a key and publishes its feed entry', async () => {
    const keyId = crypto.randomUUID();
    const entry = credentialEntry('bot_key', keyId);
    const fake = fakeAccount({
      revokeBotKey: async () => ({ outcome: 'revoked', feedEntries: [entry] }),
    });
    const feed = recordingPublisher();
    const response = await call(
      request(`/account/orgs/${ORG}/bot-keys/${keyId}`, {
        method: 'DELETE',
        token: await botToken(),
      }),
      deps(fake.access, { publish: feed.publish })
    );
    expect(response.status).toBe(204);
    expect(feed.batches).toEqual([[entry]]);
  });
});
