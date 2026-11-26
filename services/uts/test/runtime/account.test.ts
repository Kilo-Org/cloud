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
import { describe, expect, it } from 'vitest';
import {
  type AccessTokenKeys,
  checkAccountBearer,
  shardAccessTokenKeys,
} from '../../src/account/bearer';
import {
  type AccountDeps,
  type CredentialNotice,
  handleAccountRequest,
} from '../../src/account/routes';
import type { AccountAccess, AccountStore } from '../../src/account/store';
import type { SignableClaims } from '../../src/keys/claims';
import { getSignerStub } from '../../src/dos/stubs';
import { isWellFormedSecret, lastFour } from '../../src/pat/format';
import { storeFailure } from './oauth-support';
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
    for (const clientId of ['https://client.example.com/app', 'kilo-web']) {
      const response = await call(
        request('/account/pats', { token: await accessToken({ client_id: clientId }) }),
        deps(unused.access)
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'access_denied' });
    }
    expect(unused.calls).toEqual([]);
  });

  it('answers 403 with the needed scope for a token of another scope', async () => {
    const token = await accessToken({ scope: UTS_BOT_KEYS_MANAGE_SCOPE });
    const response = await call(request('/account/pats', { token }), deps(unused.access));
    expect(response.status).toBe(403);
    expect(response.headers.get('WWW-Authenticate')).toContain(`scope="${UTS_PATS_MANAGE_SCOPE}"`);
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

  it('revokes idempotently and answers 404 for no such PAT', async () => {
    for (const [outcome, status] of [
      ['revoked', 204],
      ['already_revoked', 204],
      ['not_found', 404],
      ['invalid_session', 401],
    ] as const) {
      const fake = fakeAccount({ revokePat: async () => outcome });
      const response = await call(
        request(`/account/pats/${created.id}`, { method: 'DELETE', token: await accessToken() }),
        deps(fake.access)
      );
      expect(response.status).toBe(status);
      expect(fake.calls[0].input).toMatchObject({ patId: created.id, grantId: GRANT });
    }
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

  it('revokes a key', async () => {
    const fake = fakeAccount({ revokeBotKey: async () => 'revoked' });
    const keyId = crypto.randomUUID();
    const response = await call(
      request(`/account/orgs/${ORG}/bot-keys/${keyId}`, {
        method: 'DELETE',
        token: await botToken(),
      }),
      deps(fake.access)
    );
    expect(response.status).toBe(204);
  });
});
