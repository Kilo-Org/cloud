/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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
      // Protocol state stays in the library; local tables bridge consent and
      // authenticate strict refresh replays using issued hashes.
      expect(tables.map(t => t.name)).toEqual([
        '__drizzle_migrations',
        'oauth_pending_authorizations',
        'oauth_refresh_token_history',
      ]);
      const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      expect(applied.n).toBe(5);
    });

    it('a second DO instance over the same storage does not re-apply the migration', async () => {
      createStore(db);
      const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      expect(applied.n).toBe(5);
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
    const kv = new Map<string, string>();
    const context = createFakeDoState(db);
    let store: InstanceType<typeof KiloMcpOAuthStore>;
    const getByName = vi.fn(() => store);
    const env = {
      WEB_BASE_URL: 'https://app.kilo.ai',
      KILO_MCP_OAUTH_STORE: { getByName },
      OAUTH_KV: {
        get: async (key: string, options?: { type?: string }) => {
          const value = kv.get(key) ?? null;
          return options?.type === 'json' && value !== null ? JSON.parse(value) : value;
        },
        put: async (key: string, value: string) => {
          kv.set(key, value);
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
        list: async ({ prefix }: { prefix: string }) => ({
          keys: [...kv.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })),
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
    const client = await helpers.createClient({
      redirectUris: ['https://client.test/cb'],
      tokenEndpointAuthMethod: 'none',
    });
    const verifier = 'v'.repeat(43);
    const challenge = Buffer.from(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    ).toString('base64url');
    const { redirectTo } = await helpers.completeAuthorization({
      request: {
        clientId: client.clientId,
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
        clientId: client.clientId,
      },
    });
    const post = (body: Record<string, string>) =>
      worker.fetch(
        new Request('https://kilo-mcp.test/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: client.clientId, ...body }),
        }),
        env,
        context as unknown as ExecutionContext
      );
    const exchanged = await post({
      grant_type: 'authorization_code',
      code: new URL(redirectTo).searchParams.get('code') ?? '',
      code_verifier: verifier,
      redirect_uri: 'https://client.test/cb',
    });
    expect(exchanged.status).toBe(200);
    const initial = (await exchanged.json()) as { refresh_token: string; access_token: string };
    const refresh = (token: string) => post({ grant_type: 'refresh_token', refresh_token: token });
    return {
      db,
      env,
      getByName,
      initial,
      refresh,
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
});
