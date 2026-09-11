/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NewPendingAuthorization } from './oauth-store';

// `cloudflare:workers` does not exist under plain node vitest; the DO under
// test only extends its DurableObject base, so a stub base class is enough.
// Hoist-safe: the factory closes over nothing.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { KiloMcpOAuthStore } = await import('./oauth-store');

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
    storage: {
      sql: {
        exec: (query: string, ...params: unknown[]) => sqlExec(db, query, ...params),
      },
      transactionSync: <T>(callback: () => T): T => callback(),
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
      // The hand-rolled clients/codes/refresh/jti tables were dropped by 0003;
      // only the pending-authorization table survives.
      expect(tables.map(t => t.name)).toEqual([
        '__drizzle_migrations',
        'oauth_pending_authorizations',
      ]);
      const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      expect(applied.n).toBe(4);
    });

    it('a second DO instance over the same storage does not re-apply the migration', async () => {
      createStore(db);
      const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      expect(applied.n).toBe(4);
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
