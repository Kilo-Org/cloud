/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewPendingAuthorization } from './oauth-store';
import { getOAuthApi, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import { hashRefreshToken } from '../oauth/refresh-reuse';

// `cloudflare:workers` does not exist under plain node vitest; the DO under
// test only extends its DurableObject base, so a stub base class is enough.
// Hoist-safe: the factory closes over nothing.
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {},
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { default: worker, KiloMcpOAuthStore } = await import('../index');

// Test support, inlined: a fake `DurableObjectStorage` whose `sql.exec`
// delegates to a real `node:sqlite` database, so these tests run the REAL
// drizzle durable-sqlite driver, the REAL generated migration SQL, and real
// SQLite semantics inside plain node vitest.
type CursorRow = Record<string, unknown>;

function toSqliteParam(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as string | number | bigint | Uint8Array | null;
}

function sqlExec(db: DatabaseSync, query: string, ...params: unknown[]) {
  const rows = db.prepare(query).all(...params.map(toSqliteParam)) as CursorRow[];
  const arrays = rows.map(row => Object.values(row));
  let index = 0;
  const iterator = {
    next: (): IteratorResult<CursorRow> =>
      index < rows.length
        ? { value: rows[index++], done: false }
        : { value: undefined as never, done: true },
  };
  return {
    toArray: () => rows,
    one: () => rows[0],
    raw: () => ({ toArray: () => arrays, one: () => arrays[0] }),
    next: () => iterator.next(),
    [Symbol.iterator]: () => iterator,
  };
}

/** A `DurableObjectState`-shaped fake for constructing the DO under test. */
function createFakeDoState(db: DatabaseSync) {
  const kv = new Map<string, unknown>();
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    storage: {
      sql: {
        exec: (query: string, ...params: unknown[]) => sqlExec(db, query, ...params),
      },
      transactionSync: <T>(callback: () => T): T => {
        db.exec('BEGIN');
        try {
          const result = callback();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
      getAlarm: async () => null as number | Date | null,
      setAlarm: async (_time: number | Date | string) => {},
    },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>): Promise<T> => callback(),
  };
}

const NOW = '2026-09-09T12:00:00.000Z';
const LATER = '2026-09-09T12:05:00.000Z';
const EXPIRED = '2026-09-09T11:00:00.000Z';

function createStore(db: DatabaseSync): InstanceType<typeof KiloMcpOAuthStore> {
  return new KiloMcpOAuthStore(createFakeDoState(db) as never, {} as never);
}

describe('KiloMcpOAuthStore (real drizzle durable-sqlite over node:sqlite)', () => {
  let db: DatabaseSync;
  let store: InstanceType<typeof KiloMcpOAuthStore>;

  beforeAll(async () => {
    db = new DatabaseSync(':memory:');
    store = createStore(db);
  });

  describe('migration tracking', () => {
    it('applies the tracked schema and records it in __drizzle_migrations', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      // Protocol state stays in the library; local tables bridge consent,
      // authenticate strict refresh replays using issued hashes, and hold the
      // OTP authenticators and protected requests (o2). The dropped approval
      // queue tables are gone (o5). The account-wide wrong-code limiter adds
      // `failed_attempts` and `locked_until` in migration 0008.
      expect(tables.map(t => t.name)).toEqual([
        '__drizzle_migrations',
        'mcp_admin_authenticators',
        'mcp_protected_requests',
        'oauth_pending_authorizations',
        'oauth_refresh_token_history',
      ]);
      const authenticatorColumns = db
        .prepare('PRAGMA table_info(mcp_admin_authenticators)')
        .all() as Array<{ name: string }>;
      expect(authenticatorColumns.map(column => column.name)).toContain('failed_attempts');
      expect(authenticatorColumns.map(column => column.name)).toContain('locked_until');
      const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      expect(applied.n).toBe(9);
    });

    it('a second DO instance over the same storage does not re-apply the migration', async () => {
      createStore(db);
      const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      expect(applied.n).toBe(9);
    });
  });

  describe('refresh history', () => {
    it('persists current and superseded hashes across DO recreation and isolates grants', async () => {
      const first = await hashRefreshToken('u:g:first');
      const second = await hashRefreshToken('u:g:second');
      const other = await hashRefreshToken('u:other:secret');
      await store.rememberRefreshToken(first, { userId: 'u', grantId: 'g' }, LATER);
      await store.rememberRefreshToken(other, { userId: 'u', grantId: 'other' }, LATER);
      await store.rememberRefreshToken(second, { userId: 'u', grantId: 'g' }, LATER);
      const recreated = createStore(db);
      expect(await recreated.getRefreshToken(first, NOW)).toEqual({
        userId: 'u',
        grantId: 'g',
        current: false,
      });
      expect(await recreated.getRefreshToken(second, NOW)).toEqual({
        userId: 'u',
        grantId: 'g',
        current: true,
      });
      expect(await recreated.getRefreshToken(other, NOW)).toEqual({
        userId: 'u',
        grantId: 'other',
        current: true,
      });
      expect(await recreated.getRefreshToken('u:g:second', NOW)).toBeNull();
      expect(await recreated.getRefreshToken(second, LATER)).toBeNull();
      await recreated.purgeExpired('2026-09-09T12:06:00.000Z');
      expect(db.prepare('SELECT count(*) AS n FROM oauth_refresh_token_history').get()?.n).toBe(0);
    });

    it('keeps the newest hashes when every write shares one expires_at', async () => {
      // `expiresAt` is a millisecond clock, so two rotations of one grant can
      // rank equal by `expires_at` alone. The prune must still keep the newest
      // eight by insertion order: the row just inserted and the provider's
      // other accepted token, the previous one, are both in that set, and a
      // LIMIT over an unordered tie may drop either.
      const grant = { userId: 'u', grantId: 'tied' };
      const hashes = Array.from({ length: 10 }, (_value, index) => `tied-${index}`);
      for (const hash of hashes) await store.rememberRefreshToken(hash, grant, LATER);

      const rows = db
        .prepare(
          'SELECT token_hash FROM oauth_refresh_token_history WHERE user_id = ? AND grant_id = ?'
        )
        .all('u', 'tied') as Array<{ token_hash: string }>;
      expect(rows.map(row => row.token_hash).sort()).toEqual([...hashes.slice(2)].sort());

      expect(await store.getRefreshToken('tied-9', NOW)).toEqual({
        userId: 'u',
        grantId: 'tied',
        current: true,
      });
      expect(await store.getRefreshToken('tied-8', NOW)).toEqual({
        userId: 'u',
        grantId: 'tied',
        current: false,
      });
      // The two oldest are the ones the bound is supposed to shed.
      expect(await store.getRefreshToken('tied-1', NOW)).toBeNull();
      expect(await store.getRefreshToken('tied-0', NOW)).toBeNull();
    });

    it('forgets one grant’s hashes without touching another grant', async () => {
      const revoked = await hashRefreshToken('u:revoked:first');
      const revokedNext = await hashRefreshToken('u:revoked:second');
      const live = await hashRefreshToken('u:live:only');
      await store.rememberRefreshToken(revoked, { userId: 'u', grantId: 'revoked' }, LATER);
      await store.rememberRefreshToken(revokedNext, { userId: 'u', grantId: 'revoked' }, LATER);
      await store.rememberRefreshToken(live, { userId: 'u', grantId: 'live' }, LATER);

      await store.forgetRefreshTokens({ userId: 'u', grantId: 'revoked' });

      expect(await store.getRefreshToken(revoked, NOW)).toBeNull();
      expect(await store.getRefreshToken(revokedNext, NOW)).toBeNull();
      expect(await store.getRefreshToken(live, NOW)).toEqual({
        userId: 'u',
        grantId: 'live',
        current: true,
      });
    });

    it('rolls back supersession if recording the newly issued hash fails', async () => {
      await store.rememberRefreshToken('original', { userId: 'atomic', grantId: 'g' }, LATER);
      db.exec(
        "CREATE TRIGGER fail_history BEFORE INSERT ON oauth_refresh_token_history WHEN NEW.token_hash = 'fail' BEGIN SELECT RAISE(ABORT, 'write failed'); END"
      );
      try {
        await expect(
          store.rememberRefreshToken('fail', { userId: 'atomic', grantId: 'g' }, LATER)
        ).rejects.toThrow();
        expect(await store.getRefreshToken('original', NOW)).toEqual({
          userId: 'atomic',
          grantId: 'g',
          current: true,
        });
      } finally {
        db.exec('DROP TRIGGER fail_history');
      }
    });
  });

  describe('pending authorizations (s2, library-owned flow)', () => {
    const authRequest = {
      responseType: 'code',
      clientId: 'c-1',
      redirectUri: 'https://a.test/cb',
      scope: ['mcp'],
      state: 'st',
      codeChallenge: 'challenge-value-000000000000000000000000000000',
      codeChallengeMethod: 'S256',
      resource: 'https://mcp.test/mcp',
    };
    const pendingInput = (
      overrides: Partial<NewPendingAuthorization> = {}
    ): NewPendingAuthorization => ({
      id: 'pa-1',
      authRequest,
      deviceAuthCode: 'PAIR-PA-1',
      createdAt: NOW,
      expiresAt: LATER,
      ...overrides,
    });

    it('creates a pending record and round-trips the AuthRequest JSON', async () => {
      await store.createPendingAuthorization(pendingInput());
      const record = await store.getPendingAuthorization('pa-1');
      expect(record).toMatchObject({
        id: 'pa-1',
        deviceAuthCode: 'PAIR-PA-1',
        status: 'pending',
        kiloUserId: null,
        organizationId: null,
        kiloToken: null,
        createdAt: NOW,
        expiresAt: LATER,
      });
      expect(record?.authRequest).toEqual(authRequest);
      expect(await store.getPendingAuthorization('pa-ghost')).toBeNull();
    });

    it('enforces the unique device_auth_code index across records', async () => {
      await store.createPendingAuthorization(
        pendingInput({ id: 'pa-2', deviceAuthCode: 'PAIR-PA-2' })
      );
      await expect(
        store.createPendingAuthorization(
          pendingInput({ id: 'pa-dup', deviceAuthCode: 'PAIR-PA-2' })
        )
      ).rejects.toThrow();
    });

    it('records the pairing first-writer-wins and never overwrites the token', async () => {
      expect(
        await store.recordPairingApproval(
          'PAIR-PA-1',
          { kiloUserId: 'u-1', kiloToken: 'kilo-1' },
          NOW
        )
      ).toBe(true);
      expect(
        await store.recordPairingApproval(
          'PAIR-PA-1',
          { kiloUserId: 'u-stolen', kiloToken: 'kilo-stolen' },
          NOW
        )
      ).toBe(false);
      expect(await store.getPendingAuthorization('pa-1')).toMatchObject({
        status: 'pending',
        kiloUserId: 'u-1',
        kiloToken: 'kilo-1',
      });
      expect(
        await store.recordPairingApproval('PAIR-PA-GHOST', { kiloUserId: 'u', kiloToken: 't' }, NOW)
      ).toBe(false);
    });

    it('refuses to record an expired pending authorization', async () => {
      await store.createPendingAuthorization(
        pendingInput({ id: 'pa-exp-rec', deviceAuthCode: 'PAIR-PA-EXPREC', expiresAt: EXPIRED })
      );
      expect(
        await store.recordPairingApproval(
          'PAIR-PA-EXPREC',
          { kiloUserId: 'u', kiloToken: 't' },
          NOW
        )
      ).toBe(false);
    });

    it('approves a pending authorization exactly once and keeps the recorded token', async () => {
      expect(
        await store.approvePendingAuthorization(
          'PAIR-PA-1',
          { kiloUserId: 'u-1', organizationId: 'o-1' },
          NOW
        )
      ).toBe(true);
      // not pending anymore — a second approval changes nothing.
      expect(
        await store.approvePendingAuthorization(
          'PAIR-PA-1',
          { kiloUserId: 'u-2', organizationId: null },
          NOW
        )
      ).toBe(false);
      expect(await store.getPendingAuthorization('pa-1')).toMatchObject({
        status: 'approved',
        kiloUserId: 'u-1',
        organizationId: 'o-1',
        kiloToken: 'kilo-1',
      });
      expect(
        await store.approvePendingAuthorization(
          'PAIR-PA-GHOST',
          { kiloUserId: 'u', organizationId: null },
          NOW
        )
      ).toBe(false);
    });

    it('completes only an approved, live authorization, exactly once', async () => {
      expect(await store.completePendingAuthorization('pa-not-approved', NOW)).toBe(false);
      await store.createPendingAuthorization(
        pendingInput({ id: 'pa-not-approved', deviceAuthCode: 'PAIR-PA-NA' })
      );
      expect(await store.completePendingAuthorization('pa-not-approved', NOW)).toBe(false);

      expect(await store.completePendingAuthorization('pa-1', NOW)).toBe(true);
      expect(await store.completePendingAuthorization('pa-1', NOW)).toBe(false);
      expect((await store.getPendingAuthorization('pa-1'))?.status).toBe('completed');
      expect(await store.completePendingAuthorization('pa-ghost', NOW)).toBe(false);
    });

    it('refuses to complete an approved authorization after expiry', async () => {
      await store.createPendingAuthorization(
        pendingInput({ id: 'pa-complete-exp', deviceAuthCode: 'PAIR-PA-CEX', expiresAt: LATER })
      );
      await store.approvePendingAuthorization(
        'PAIR-PA-CEX',
        { kiloUserId: 'u', organizationId: null },
        NOW
      );
      expect(await store.completePendingAuthorization('pa-complete-exp', LATER)).toBe(false);
      expect((await store.getPendingAuthorization('pa-complete-exp'))?.status).toBe('approved');
    });

    it('releases an approved authorization back to retryable pending, exactly once', async () => {
      await store.createPendingAuthorization(
        pendingInput({ id: 'pa-release', deviceAuthCode: 'PAIR-PA-REL' })
      );
      // Still pending: nothing to release.
      expect(await store.releasePendingAuthorization('pa-release', NOW)).toBe(false);
      expect(
        await store.approvePendingAuthorization(
          'PAIR-PA-REL',
          { kiloUserId: 'u-rel', organizationId: 'o-rel' },
          NOW
        )
      ).toBe(true);
      expect(await store.releasePendingAuthorization('pa-release', NOW)).toBe(true);
      // The pairing is kept (the retry must not repeat sign-in) but the org
      // choice is dropped with the non-terminal status.
      expect(await store.getPendingAuthorization('pa-release')).toMatchObject({
        status: 'pending',
        kiloUserId: 'u-rel',
        organizationId: null,
      });
      expect(await store.releasePendingAuthorization('pa-release', NOW)).toBe(false);
      expect(await store.releasePendingAuthorization('pa-ghost', NOW)).toBe(false);
    });

    it('refuses to release an approved authorization after expiry', async () => {
      await store.createPendingAuthorization(
        pendingInput({ id: 'pa-release-exp', deviceAuthCode: 'PAIR-PA-REX', expiresAt: LATER })
      );
      await store.approvePendingAuthorization(
        'PAIR-PA-REX',
        { kiloUserId: 'u', organizationId: null },
        NOW
      );
      expect(await store.releasePendingAuthorization('pa-release-exp', LATER)).toBe(false);
      expect((await store.getPendingAuthorization('pa-release-exp'))?.status).toBe('approved');
    });

    it('denies a pending authorization exactly once', async () => {
      await store.createPendingAuthorization(
        pendingInput({ id: 'pa-deny', deviceAuthCode: 'PAIR-PA-DENY' })
      );
      expect(await store.denyPendingAuthorization('PAIR-PA-DENY', NOW)).toBe(true);
      expect((await store.getPendingAuthorization('pa-deny'))?.status).toBe('denied');
      expect(await store.denyPendingAuthorization('PAIR-PA-DENY', NOW)).toBe(false);
      expect(await store.denyPendingAuthorization('PAIR-PA-GHOST', NOW)).toBe(false);
    });

    it('expires a pending authorization exactly once', async () => {
      await store.createPendingAuthorization(
        pendingInput({ id: 'pa-expire', deviceAuthCode: 'PAIR-PA-EXP' })
      );
      expect(await store.expirePendingAuthorization('PAIR-PA-EXP', NOW)).toBe(true);
      expect((await store.getPendingAuthorization('pa-expire'))?.status).toBe('expired');
      expect(await store.expirePendingAuthorization('PAIR-PA-EXP', NOW)).toBe(false);
      expect(await store.expirePendingAuthorization('PAIR-PA-GHOST', NOW)).toBe(false);
    });

    it('purges expired pending rows and keeps live ones', async () => {
      await store.createPendingAuthorization(
        pendingInput({
          id: 'pa-purge',
          deviceAuthCode: 'PAIR-PA-PURGE',
          createdAt: EXPIRED,
          expiresAt: EXPIRED,
        })
      );
      const deleted = await store.purgeExpired(NOW);
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await store.getPendingAuthorization('pa-purge')).toBeNull();
      expect(await store.getPendingAuthorization('pa-2')).not.toBeNull();
    });
  });
});

describe('production token routing (real provider + DO SQLite)', () => {
  async function harness() {
    const db = new DatabaseSync(':memory:');
    // A `KVNamespace` fake that honours the write options the provider passes,
    // against the same clock the provider reads. Without this an entry the
    // provider asked to expire is still served, and a lifetime assertion passes
    // vacuously. `expirationTtl` is a relative number of seconds;
    // `expiration` is an absolute epoch second (`saveGrantWithTTL`).
    type FakeKvEntry = { value: string; expiresAtMs: number | null };
    const kv = new Map<string, FakeKvEntry>();
    const isExpired = (entry: FakeKvEntry) =>
      entry.expiresAtMs !== null && Date.now() >= entry.expiresAtMs;
    const context = createFakeDoState(db);
    let store: InstanceType<typeof KiloMcpOAuthStore>;
    const getByName = vi.fn(() => store);
    const env = {
      WEB_BASE_URL: 'https://app.kilo.ai',
      KILO_MCP_OAUTH_STORE: { getByName },
      OAUTH_KV: {
        get: async (key: string, options?: { type?: string }) => {
          const entry = kv.get(key);
          if (!entry) return null;
          if (isExpired(entry)) {
            kv.delete(key);
            return null;
          }
          return options?.type === 'json' ? JSON.parse(entry.value) : entry.value;
        },
        put: async (
          key: string,
          value: string,
          options?: { expirationTtl?: number; expiration?: number }
        ) => {
          const expiresAtMs =
            options?.expirationTtl !== undefined
              ? Date.now() + options.expirationTtl * 1000
              : options?.expiration !== undefined
                ? options.expiration * 1000
                : null;
          kv.set(key, { value, expiresAtMs });
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
        list: async ({ prefix }: { prefix: string }) => ({
          keys: [...kv.entries()]
            .filter(([key, entry]) => key.startsWith(prefix) && !isExpired(entry))
            .map(([name]) => ({ name })),
          list_complete: true,
        }),
      },
    } as unknown as Env;
    store = new KiloMcpOAuthStore(context as unknown as DurableObjectState, env);
    const providerOptions: OAuthProviderOptions<Env> = {
      apiRoute: '/mcp',
      apiHandler: { fetch: async () => Response.json({}) },
      defaultHandler: { fetch: async () => new Response('Not found', { status: 404 }) },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      scopesSupported: ['mcp'],
    };
    const helpers = getOAuthApi(providerOptions, env);
    // Register through the worker's real `/register` route (not the helpers),
    // so the client record's lifetime is the one `providerOptions` in
    // `src/index.ts` actually writes.
    const registered = await worker.fetch(
      new Request('https://kilo-mcp.test/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://client.test/cb'],
          token_endpoint_auth_method: 'none',
        }),
      }),
      env,
      context as unknown as ExecutionContext
    );
    expect(registered.status).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    const verifier = 'v'.repeat(43);
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    ).toString('base64url');
    const { redirectTo } = await helpers.completeAuthorization({
      request: {
        clientId: client.client_id,
        redirectUri: 'https://client.test/cb',
        responseType: 'code',
        scope: ['mcp'],
        state: 'state',
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
        resource: 'https://kilo-mcp.test/mcp',
      },
      userId: 'user',
      scope: ['mcp'],
      metadata: {},
      props: {
        kiloUserId: 'user',
        kiloToken: 'kilo-token',
        organizationId: null,
        clientId: client.client_id,
      },
    });
    const post = (body: Record<string, string>) =>
      worker.fetch(
        new Request('https://kilo-mcp.test/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: client.client_id, ...body }),
        }),
        env,
        context as unknown as ExecutionContext
      );
    const exchange = (code: string) =>
      post({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'https://client.test/cb',
      });
    const exchanged = await exchange(new URL(redirectTo).searchParams.get('code') ?? '');
    expect(exchanged.status).toBe(200);
    const initial = (await exchanged.json()) as { refresh_token: string; access_token: string };
    const refresh = (token: string) => post({ grant_type: 'refresh_token', refresh_token: token });
    /**
     * Drive the REAL browser consent flow (`/authorize` -> `/authorize/status`
     * -> `/authorize/org`) so the completion path's client-record renewal runs,
     * and return the authorization code the client would exchange. Only the
     * apps/web device-auth pairing calls are stubbed, on the global fetch the
     * consent deps fall back to when no `fetchImpl` is injected.
     */
    const signIn = async (): Promise<string> => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL) => {
          const url = String(input);
          if (url.endsWith('/api/device-auth/codes')) {
            return Response.json({ code: 'PAIR-1' });
          }
          if (url.endsWith('/api/device-auth/codes/PAIR-1')) {
            return Response.json({ status: 'approved', token: 'kilo-token-2', userId: 'user-2' });
          }
          throw new Error(`unexpected fetch during the consent flow: ${url}`);
        })
      );
      const url = new URL('https://kilo-mcp.test/authorize');
      url.searchParams.set('client_id', client.client_id);
      url.searchParams.set('redirect_uri', 'https://client.test/cb');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('scope', 'mcp');
      url.searchParams.set('state', 'state');
      url.searchParams.set('resource', 'https://kilo-mcp.test/mcp');
      const page = await worker.fetch(
        new Request(url),
        env,
        context as unknown as ExecutionContext
      );
      expect(page.status).toBe(200);
      // The pending record the consent page just created carries its own id.
      const row = db
        .prepare('SELECT id FROM oauth_pending_authorizations ORDER BY created_at DESC LIMIT 1')
        .get() as { id: string } | undefined;
      const id = row?.id ?? '';
      const status = await worker.fetch(
        new Request(`https://kilo-mcp.test/authorize/status?id=${encodeURIComponent(id)}`),
        env,
        context as unknown as ExecutionContext
      );
      expect(status.status).toBe(200);
      const chosen = await worker.fetch(
        new Request(`https://kilo-mcp.test/authorize/org?id=${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ organization_id: 'personal' }),
        }),
        env,
        context as unknown as ExecutionContext
      );
      expect(chosen.status).toBe(302);
      const code = new URL(chosen.headers.get('Location') as string).searchParams.get('code');
      if (!code) throw new Error('the consent flow returned no authorization code');
      return code;
    };
    return {
      db,
      env,
      getByName,
      initial,
      refresh,
      exchange,
      signIn,
      recreate: () => {
        store = new KiloMcpOAuthStore(context as unknown as DurableObjectState, env);
      },
      mcp: (access: string) =>
        worker.fetch(
          new Request('https://kilo-mcp.test/mcp', {
            method: 'POST',
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
          }),
          env,
          context as unknown as ExecutionContext
        ),
    };
  }

  it('serializes concurrent refreshes and cannot resurrect the revoked grant', async () => {
    const h = await harness();
    try {
      const responses = await Promise.all([
        h.refresh(h.initial.refresh_token),
        h.refresh(h.initial.refresh_token),
      ]);
      expect(responses.map(response => response.status)).toEqual([200, 400]);
      const newest = (await responses[0]!.json()) as {
        refresh_token: string;
        access_token: string;
      };
      expect(await responses[1]!.json()).toMatchObject({ error: 'invalid_grant' });
      expect((await h.refresh(newest.refresh_token)).status).toBe(400);
      expect((await h.mcp(newest.access_token)).status).toBe(401);
      expect((await h.mcp(h.initial.access_token)).status).toBe(401);
      expect(h.getByName).toHaveBeenCalledWith('kilo-mcp-oauth');
    } finally {
      h.db.close();
    }
  });

  it('forged public parts cannot revoke; successive rotations work and historic replay revokes after restart', async () => {
    const h = await harness();
    try {
      const [user, grant] = h.initial.refresh_token.split(':');
      const forged = await h.refresh(`${user}:${grant}:forged`);
      expect(forged.status).toBe(400);
      expect(await forged.json()).toMatchObject({
        error: 'invalid_grant',
        error_description: 'Invalid refresh token',
      });
      expect((await h.mcp(h.initial.access_token)).status).toBe(200);
      const secondResponse = await h.refresh(h.initial.refresh_token);
      expect(secondResponse.status).toBe(200);
      const second = (await secondResponse.json()) as { refresh_token: string };
      h.recreate();
      const thirdResponse = await h.refresh(second.refresh_token);
      expect(thirdResponse.status).toBe(200);
      const third = (await thirdResponse.json()) as { refresh_token: string; access_token: string };
      expect((await h.refresh(h.initial.refresh_token)).status).toBe(400);
      expect((await h.refresh(third.refresh_token)).status).toBe(400);
      expect((await h.mcp(third.access_token)).status).toBe(401);
    } finally {
      h.db.close();
    }
  });

  it('forgets a revoked grant’s history instead of keeping it for the one-year TTL', async () => {
    const h = await harness();
    try {
      const [, grantId] = h.initial.refresh_token.split(':');
      const historyRows = () =>
        h.db
          .prepare(
            'SELECT token_hash FROM oauth_refresh_token_history WHERE user_id = ? AND grant_id = ?'
          )
          .all('user', grantId ?? '') as Array<{ token_hash: string }>;
      expect((await h.refresh(h.initial.refresh_token)).status).toBe(200);
      expect(historyRows()).toHaveLength(2);

      // A superseded hash replay is the guard's revoke path: the grant dies, so
      // its hashes can never authenticate another replay and must not sit in
      // the single global DO until the TTL would remove them.
      const replay = await h.refresh(h.initial.refresh_token);
      expect(replay.status).toBe(400);
      expect(await replay.json()).toMatchObject({
        error: 'invalid_grant',
        error_description: 'Refresh token reuse detected; the grant has been revoked.',
      });
      expect(historyRows()).toHaveLength(0);
    } finally {
      h.db.close();
    }
  });

  describe('session lifetime (one sign-in per year)', () => {
    /** Day 0: the instant the authorization code is exchanged for a grant. */
    const SESSION_START_MS = Date.UTC(2026, 0, 1, 12);
    const atDay = (day: number) => SESSION_START_MS + day * 24 * 60 * 60 * 1000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(SESSION_START_MS);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('continues a live session past the old 30-day cap', async () => {
      const h = await harness();
      try {
        vi.setSystemTime(atDay(31));
        const refreshed = await h.refresh(h.initial.refresh_token);
        expect(refreshed.status).toBe(200);
        const rotated = (await refreshed.json()) as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
        };
        // The wire contract the client keeps using, silently.
        expect(rotated.expires_in).toBe(3600);
        expect((await h.mcp(rotated.access_token)).status).toBe(200);
        // An hourly access token dying is not the session dying.
        expect((await h.mcp(h.initial.access_token)).status).toBe(401);
      } finally {
        h.db.close();
      }
    });

    it('keeps rotating a live session at day 100, past the old 90-day client record', async () => {
      const h = await harness();
      try {
        // The DCR record is looked up before the grant; if it were evicted
        // inside the session the refresh would be `401 invalid_client`.
        vi.setSystemTime(atDay(100));
        const refreshed = await h.refresh(h.initial.refresh_token);
        expect(refreshed.status).toBe(200);
        const rotated = (await refreshed.json()) as { access_token: string };
        expect((await h.mcp(rotated.access_token)).status).toBe(200);
      } finally {
        h.db.close();
      }
    });

    it('ends the session at the year bound instead of renewing it forever', async () => {
      const h = await harness();
      try {
        vi.setSystemTime(atDay(364));
        const refreshed = await h.refresh(h.initial.refresh_token);
        expect(refreshed.status).toBe(200);
        const rotated = (await refreshed.json()) as { access_token: string; refresh_token: string };
        expect((await h.mcp(rotated.access_token)).status).toBe(200);

        vi.setSystemTime(atDay(366));
        const lapsed = await h.refresh(rotated.refresh_token);
        expect(lapsed.status).toBe(400);
        // Only the OAuth error is contractual: the grant's KV expiration may
        // report "Grant not found" rather than "Refresh token has expired".
        expect(await lapsed.json()).toMatchObject({ error: 'invalid_grant' });
        // The MCP surface answers with the bearer challenge, so the client
        // re-runs the authorization-code exchange instead of retrying.
        const refused = await h.mcp(rotated.access_token);
        expect(refused.status).toBe(401);
        expect(refused.headers.get('WWW-Authenticate')).toContain('Bearer');
      } finally {
        h.db.close();
      }
    });

    it('re-anchors the client record to a session that starts after registration, so it lasts its full year', async () => {
      // The DCR record is written at registration (day 0); its lifetime cannot
      // be anchored there, or a session that starts later outlives its own
      // record and dies with `401 invalid_client` instead of `invalid_grant`.
      const h = await harness();
      try {
        // The user signs in through the real consent flow 40 days after the
        // client registered. The grant minted now runs to day 405, while the
        // day-0 record would expire at day 395.
        vi.setSystemTime(atDay(40));
        const exchanged = await h.exchange(await h.signIn());
        expect(exchanged.status).toBe(200);
        const session = (await exchanged.json()) as {
          refresh_token: string;
          access_token: string;
        };

        // Day 396 is past the day-0 record but inside the grant: the renewal
        // at authorization is what keeps this a live session.
        vi.setSystemTime(atDay(396));
        const refreshed = await h.refresh(session.refresh_token);
        expect(refreshed.status).toBe(200);
        const rotated = (await refreshed.json()) as { access_token: string; refresh_token: string };
        expect((await h.mcp(rotated.access_token)).status).toBe(200);

        // The re-anchored record still lets the session end at its own bound.
        vi.setSystemTime(atDay(406));
        const lapsed = await h.refresh(rotated.refresh_token);
        expect(lapsed.status).toBe(400);
        expect(await lapsed.json()).toMatchObject({ error: 'invalid_grant' });

        // The margin is anchored to this grant too: 15 days after the session
        // bound the record is still there, so the lapsed session reads as
        // `invalid_grant` (re-authorize) rather than `invalid_client`. A record
        // left anchored at day 0 would have expired at day 395.
        vi.setSystemTime(atDay(420));
        const reauthorize = await h.refresh(rotated.refresh_token);
        expect(reauthorize.status).toBe(400);
        expect(await reauthorize.json()).toMatchObject({ error: 'invalid_grant' });
      } finally {
        h.db.close();
      }
    });
  });

  describe('bounded refresh-history memory (one global DO)', () => {
    /** Day 0: the second the grant is minted by `harness`. */
    const SESSION_START_MS = Date.UTC(2026, 0, 1, 12);
    const atSecond = (second: number) => SESSION_START_MS + second * 1000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(SESSION_START_MS);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('keeps only the newest 8 hashes and still refuses a replay after pruning', async () => {
      const h = await harness();
      try {
        const [, grantId] = h.initial.refresh_token.split(':');
        const issued = [h.initial.refresh_token];
        for (let i = 1; i <= 20; i++) {
          // A real rotation lands milliseconds apart; step the clock a second
          // so the prune order is the order the tokens were issued.
          vi.setSystemTime(atSecond(i));
          const response = await h.refresh(issued[i - 1]!);
          expect(response.status).toBe(200);
          issued.push(((await response.json()) as { refresh_token: string }).refresh_token);
        }

        const rows = h.db
          .prepare(
            'SELECT token_hash, current FROM oauth_refresh_token_history WHERE user_id = ? AND grant_id = ? ORDER BY expires_at DESC'
          )
          .all('user', grantId) as Array<{ token_hash: string; current: number }>;
        const hashes = await Promise.all(issued.map(token => hashRefreshToken(token)));
        // (i) A year of rotations cannot grow the single global DO without bound.
        expect(rows).toHaveLength(8);
        // (ii) Both tokens the provider still accepts survive with right flags.
        expect(rows[0]).toEqual({ token_hash: hashes[20], current: 1 });
        expect(rows[1]).toEqual({ token_hash: hashes[19], current: 0 });
        expect(rows.slice(2).every(row => row.current === 0)).toBe(true);

        // (iii) A pruned hash is no longer matched by the guard, so the replay
        // reaches the provider and is refused there — and the grant stays alive
        // for the token the client actually holds.
        vi.setSystemTime(atSecond(21));
        const replay = await h.refresh(issued[0]!);
        expect(replay.status).toBe(400);
        expect(await replay.json()).toMatchObject({
          error: 'invalid_grant',
          error_description: 'Invalid refresh token',
        });
        expect((await h.refresh(issued[20]!)).status).toBe(200);

        // The two tokens the provider still accepts stay detectable after
        // pruning: replaying the immediately previous one is still a guard
        // revocation, not a forwarded rotation.
        vi.setSystemTime(atSecond(22));
        const previous = await h.refresh(issued[19]!);
        expect(previous.status).toBe(400);
        expect(await previous.json()).toMatchObject({
          error: 'invalid_grant',
          error_description: 'Refresh token reuse detected; the grant has been revoked.',
        });
      } finally {
        h.db.close();
      }
    });
  });
});
