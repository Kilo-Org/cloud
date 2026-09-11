/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NewRefreshToken } from './oauth-store';

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
    it('applies the v1 schema and records it in __drizzle_migrations', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(tables.map(t => t.name)).toEqual(
        expect.arrayContaining([
          '__drizzle_migrations',
          'oauth_clients',
          'oauth_codes',
          'oauth_refresh_tokens',
          'oauth_revoked_jtis',
        ])
      );
      const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      expect(applied.n).toBe(2);
    });

    it('a second DO instance over the same storage does not re-apply the migration', async () => {
      createStore(db);
      const applied = db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as {
        n: number;
      };
      expect(applied.n).toBe(2);
    });
  });

  describe('clients', () => {
    it('persists and retrieves a registration; unknown ids return null', async () => {
      await store.registerClient({
        clientId: 'c-1',
        redirectUris: ['https://a.test/cb', 'http://localhost:1/cb'],
        clientName: 'CLI',
        createdAt: NOW,
      });
      expect(await store.getClient('c-1')).toEqual({
        clientId: 'c-1',
        redirectUris: ['https://a.test/cb', 'http://localhost:1/cb'],
        clientName: 'CLI',
        createdAt: NOW,
      });
      expect(await store.getClient('ghost')).toBeNull();
    });

    it('rejects a duplicate client_id (primary key)', async () => {
      await expect(
        store.registerClient({
          clientId: 'c-1',
          redirectUris: ['https://a.test/cb'],
          clientName: 'dup',
          createdAt: NOW,
        })
      ).rejects.toThrow();
    });
  });

  describe('codes: TTL + single use', () => {
    const codeInput = {
      code: 'code-1',
      clientId: 'c-1',
      redirectUri: 'https://a.test/cb',
      codeChallenge: 'challenge-value-000000000000000000000000000000',
      resource: 'https://mcp.test/mcp',
      scope: 'mcp',
      state: 'st',
      deviceAuthCode: 'PAIR-1',
      createdAt: NOW,
      expiresAt: LATER,
    };

    it('creates a pending record and approves it exactly once', async () => {
      await store.createCode(codeInput);
      expect((await store.getCode('code-1'))?.status).toBe('pending');
      expect(
        await store.approveCode('PAIR-1', { kiloUserId: 'u-1', organizationId: 'o-1' }, NOW)
      ).toBe(true);
      // already approved — a second approval changes nothing
      expect(
        await store.approveCode('PAIR-1', { kiloUserId: 'u-2', organizationId: null }, NOW)
      ).toBe(false);
      const approved = await store.getCode('code-1');
      expect(approved?.kiloUserId).toBe('u-1');
      expect(approved?.organizationId).toBe('o-1');
    });

    it('consumes the code atomically and rejects reuse', async () => {
      const consumed = await store.consumeCode('code-1', NOW);
      expect(consumed).toMatchObject({ code: 'code-1', status: 'used', kiloUserId: 'u-1' });
      expect(await store.consumeCode('code-1', LATER)).toBeNull();
    });

    it('refuses to consume an expired code', async () => {
      await store.createCode({ ...codeInput, code: 'code-expired', deviceAuthCode: 'PAIR-X' });
      // Approved while still alive (11:00 < expiresAt 12:05), redeemed after expiry.
      await store.approveCode('PAIR-X', { kiloUserId: 'u-1', organizationId: null }, EXPIRED);
      expect(await store.consumeCode('code-expired', LATER)).toBeNull();
      expect((await store.getCode('code-expired'))?.status).toBe('approved');
    });

    it('refuses to consume a pending (unapproved) code', async () => {
      await store.createCode({ ...codeInput, code: 'code-pending', deviceAuthCode: 'PAIR-P' });
      expect(await store.consumeCode('code-pending', NOW)).toBeNull();
    });

    it('enforces the unique device_auth_code index', async () => {
      // code-1 already holds device_auth_code PAIR-1.
      await expect(store.createCode({ ...codeInput, code: 'code-dup-device' })).rejects.toThrow();
    });
  });

  describe('pairing approval + denial (s6)', () => {
    const pairInput = {
      code: 's6-code-1',
      clientId: 'c-1',
      redirectUri: 'https://a.test/cb',
      codeChallenge: 'challenge-value-000000000000000000000000000000',
      resource: 'https://mcp.test/mcp',
      scope: 'mcp',
      state: null,
      deviceAuthCode: 'PAIR-S6',
      createdAt: NOW,
      expiresAt: LATER,
    };

    it('records the approved pairing without changing the status (org comes later)', async () => {
      await store.createCode(pairInput);
      expect(
        await store.recordPairingApproval(
          'PAIR-S6',
          { kiloUserId: 'u-9', kiloToken: 'kilo-s6' },
          NOW
        )
      ).toBe(true);
      const record = await store.getCode('s6-code-1');
      expect(record).toMatchObject({
        status: 'pending',
        kiloUserId: 'u-9',
        organizationId: null,
        kiloToken: 'kilo-s6',
      });
    });

    it('the first approval wins: a second poll can never overwrite the stored credential', async () => {
      await store.recordPairingApproval(
        'PAIR-S6',
        { kiloUserId: 'u-other', kiloToken: 'kilo-stolen' },
        NOW
      );
      const record = await store.getCode('s6-code-1');
      expect(record).toMatchObject({ kiloUserId: 'u-9', kiloToken: 'kilo-s6' });
    });

    it('refuses to record for unknown, expired, or non-pending pairings', async () => {
      expect(
        await store.recordPairingApproval('PAIR-GHOST', { kiloUserId: 'u', kiloToken: 't' }, NOW)
      ).toBe(false);
      await store.createCode({ ...pairInput, code: 's6-expired', deviceAuthCode: 'PAIR-S6X' });
      expect(
        await store.recordPairingApproval('PAIR-S6X', { kiloUserId: 'u', kiloToken: 't' }, LATER)
      ).toBe(false);
      await store.approveCode('PAIR-S6X', { kiloUserId: 'u', organizationId: null }, NOW);
      expect(
        await store.recordPairingApproval('PAIR-S6X', { kiloUserId: 'u', kiloToken: 't' }, NOW)
      ).toBe(false);
    });

    it('approveCode keeps the recorded Kilo token', async () => {
      await store.createCode({ ...pairInput, code: 's6-code-2', deviceAuthCode: 'PAIR-S6-2' });
      await store.recordPairingApproval(
        'PAIR-S6-2',
        { kiloUserId: 'u-9', kiloToken: 'kilo-s6' },
        NOW
      );
      expect(
        await store.approveCode('PAIR-S6-2', { kiloUserId: 'u-9', organizationId: 'o-9' }, NOW)
      ).toBe(true);
      expect(await store.getCode('s6-code-2')).toMatchObject({
        status: 'approved',
        organizationId: 'o-9',
        kiloToken: 'kilo-s6',
      });
    });

    it('denyCode moves a pending pairing to denied exactly once', async () => {
      await store.createCode({ ...pairInput, code: 's6-deny', deviceAuthCode: 'PAIR-DENY' });
      expect(await store.denyCode('PAIR-DENY', NOW)).toBe(true);
      expect((await store.getCode('s6-deny'))?.status).toBe('denied');
      expect(await store.denyCode('PAIR-DENY', NOW)).toBe(false);
      expect(await store.denyCode('PAIR-GHOST', NOW)).toBe(false);
    });
  });

  describe('getKiloToken (forwarding credential, s6)', () => {
    const identity = {
      kiloUserId: 'u-k',
      clientId: 'c-k',
      organizationId: null,
      resource: 'https://mcp.test/mcp',
    };
    const grant = (
      id: string,
      createdAt: string,
      overrides: Partial<NewRefreshToken> = {}
    ): NewRefreshToken => ({
      id,
      tokenHash: `${id}${'0'.repeat(60)}`.slice(0, 64),
      clientId: 'c-k',
      kiloUserId: 'u-k',
      organizationId: null,
      kiloToken: `kilo-${id}`,
      resource: 'https://mcp.test/mcp',
      scope: 'mcp',
      createdAt,
      expiresAt: '2099-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('returns the newest live grant for the exact identity', async () => {
      await store.saveRefreshToken(grant('g-old', NOW));
      await store.saveRefreshToken(grant('g-new', LATER));
      expect(await store.getKiloToken(identity, NOW)).toBe('kilo-g-new');
    });

    it('skips revoked and expired grants and other identities', async () => {
      expect(await store.getKiloToken({ ...identity, kiloUserId: 'ghost-user' }, NOW)).toBeNull();
      expect(await store.getKiloToken({ ...identity, clientId: 'ghost-client' }, NOW)).toBeNull();
      await store.rotateRefreshToken('g-new', grant('g-rot', '2098-01-01T00:00:00.000Z'), NOW);
      // rotation revoked g-new; the rotated row carries the credential forward
      expect(await store.getKiloToken(identity, NOW)).toBe('kilo-g-rot');
      expect(await store.getKiloToken(identity, '2099-01-02T00:00:00.000Z')).toBeNull();
    });

    it('never forwards a credential from a different org or resource grant', async () => {
      await store.saveRefreshToken(
        grant('g-org-a', NOW, { organizationId: 'org-a', kiloToken: 'kilo-org-a' })
      );
      await store.saveRefreshToken(
        grant('g-org-b', LATER, { organizationId: 'org-b', kiloToken: 'kilo-org-b' })
      );
      await store.saveRefreshToken(
        grant('g-other-resource', LATER, {
          organizationId: 'org-a',
          resource: 'https://other-mcp.test/mcp',
          kiloToken: 'kilo-other-resource',
        })
      );
      await store.saveRefreshToken(grant('g-null-org', LATER, { kiloToken: 'kilo-null-org' }));
      expect(await store.getKiloToken({ ...identity, organizationId: 'org-a' }, NOW)).toBe(
        'kilo-org-a'
      );
      expect(await store.getKiloToken({ ...identity, organizationId: 'org-b' }, NOW)).toBe(
        'kilo-org-b'
      );
      // A null-org identity matches only null-org rows, never the org rows —
      // g-org-b is the newest grant overall, so a broken org filter would surface it.
      const nullOrg = await store.getKiloToken(identity, NOW);
      expect(nullOrg).not.toBe('kilo-org-b');
      // The same org but a different resource indicator is a different grant.
      expect(
        await store.getKiloToken(
          { ...identity, organizationId: 'org-a', resource: 'https://third-mcp.test/mcp' },
          NOW
        )
      ).toBeNull();
    });

    it('a grant without a Kilo token never surfaces a stale one', async () => {
      await store.saveRefreshToken(
        grant('g-legacy', NOW, {
          kiloToken: null,
          kiloUserId: 'u-legacy',
          clientId: 'c-legacy',
          tokenHash: 'f'.repeat(64),
        })
      );
      expect(
        await store.getKiloToken(
          { ...identity, kiloUserId: 'u-legacy', clientId: 'c-legacy' },
          NOW
        )
      ).toBeNull();
    });
  });

  describe('refresh tokens: hashed + rotation', () => {
    const tokenInput = {
      id: 'rt-1',
      tokenHash: 'a'.repeat(64),
      clientId: 'c-1',
      kiloUserId: 'u-1',
      organizationId: 'o-1',
      kiloToken: 'kilo-tok-rt-1',
      resource: 'https://mcp.test/mcp',
      scope: 'mcp',
      createdAt: NOW,
      expiresAt: LATER,
    };

    it('stores and retrieves by hash only', async () => {
      await store.saveRefreshToken(tokenInput);
      expect(await store.getRefreshTokenByHash('a'.repeat(64))).toMatchObject({
        id: 'rt-1',
        revokedAt: null,
      });
      expect(await store.getRefreshTokenByHash('b'.repeat(64))).toBeNull();
    });

    it('rotates: revokes the old row and inserts the new one', async () => {
      const rotated = await store.rotateRefreshToken(
        'rt-1',
        { ...tokenInput, id: 'rt-2', tokenHash: 'b'.repeat(64) },
        NOW
      );
      expect(rotated).toBe(true);
      expect((await store.getRefreshTokenByHash('a'.repeat(64)))?.revokedAt).toBe(NOW);
      expect((await store.getRefreshTokenByHash('b'.repeat(64)))?.revokedAt).toBeNull();
    });

    it('refuses to rotate an already-revoked token', async () => {
      expect(
        await store.rotateRefreshToken(
          'rt-1',
          { ...tokenInput, id: 'rt-3', tokenHash: 'c'.repeat(64) },
          NOW
        )
      ).toBe(false);
      expect(await store.getRefreshTokenByHash('c'.repeat(64))).toBeNull();
    });

    it('refuses to rotate an expired token', async () => {
      await store.saveRefreshToken({
        ...tokenInput,
        id: 'rt-exp',
        tokenHash: 'd'.repeat(64),
        expiresAt: EXPIRED,
      });
      expect(
        await store.rotateRefreshToken(
          'rt-exp',
          { ...tokenInput, id: 'rt-4', tokenHash: 'e'.repeat(64) },
          NOW
        )
      ).toBe(false);
    });

    it('enforces the unique token hash', async () => {
      await expect(store.saveRefreshToken({ ...tokenInput, id: 'rt-dup' })).rejects.toThrow();
    });
  });

  describe('revokeGrant (stolen-grant revocation, RFC 9700)', () => {
    const grantInput = (overrides: Partial<NewRefreshToken> = {}): NewRefreshToken => ({
      id: 'rg-1',
      tokenHash: '1'.repeat(64),
      clientId: 'c-rg',
      kiloUserId: 'u-rg',
      organizationId: 'o-rg',
      kiloToken: 'kilo-rg',
      resource: 'https://mcp.test/mcp',
      scope: 'mcp',
      createdAt: NOW,
      expiresAt: LATER,
      ...overrides,
    });

    it('revokes every live row of one grant identity and nothing else', async () => {
      await store.saveRefreshToken(grantInput({ id: 'rg-a', tokenHash: '1'.repeat(64) }));
      await store.saveRefreshToken(grantInput({ id: 'rg-b', tokenHash: '2'.repeat(64) }));
      await store.saveRefreshToken(
        grantInput({ id: 'rg-exp', tokenHash: '3'.repeat(64), expiresAt: EXPIRED })
      );
      await store.saveRefreshToken(
        grantInput({ id: 'rg-user', tokenHash: '4'.repeat(64), kiloUserId: 'u-other' })
      );
      await store.saveRefreshToken(
        grantInput({ id: 'rg-org', tokenHash: '5'.repeat(64), organizationId: null })
      );
      expect(
        await store.revokeGrant(
          {
            clientId: 'c-rg',
            kiloUserId: 'u-rg',
            organizationId: 'o-rg',
            resource: 'https://mcp.test/mcp',
          },
          NOW
        )
      ).toBe(2);
      expect((await store.getRefreshTokenByHash('1'.repeat(64)))?.revokedAt).toBe(NOW);
      expect((await store.getRefreshTokenByHash('2'.repeat(64)))?.revokedAt).toBe(NOW);
      // Not the expired row, another user, or the org-less sibling grant.
      expect((await store.getRefreshTokenByHash('3'.repeat(64)))?.revokedAt).toBeNull();
      expect((await store.getRefreshTokenByHash('4'.repeat(64)))?.revokedAt).toBeNull();
      expect((await store.getRefreshTokenByHash('5'.repeat(64)))?.revokedAt).toBeNull();
      // Idempotent: nothing live is left in the grant.
      expect(
        await store.revokeGrant(
          {
            clientId: 'c-rg',
            kiloUserId: 'u-rg',
            organizationId: 'o-rg',
            resource: 'https://mcp.test/mcp',
          },
          NOW
        )
      ).toBe(0);
    });
  });

  describe('jti revocation registry', () => {
    it('flags revoked jtis and tolerates double-revoke', async () => {
      expect(await store.isJtiRevoked('jti-1')).toBe(false);
      await store.revokeJti('jti-1', LATER, NOW);
      expect(await store.isJtiRevoked('jti-1')).toBe(true);
      await store.revokeJti('jti-1', LATER, NOW);
      expect(await store.isJtiRevoked('jti-1')).toBe(true);
    });
  });

  describe('purgeExpired', () => {
    it('drops rows past their own expiry and keeps live ones', async () => {
      db.prepare(
        'INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, resource, scope, state, device_auth_code, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        'purge-me',
        'c-1',
        'https://a.test/cb',
        'ch',
        'res',
        'mcp',
        null,
        'PAIR-PURGE',
        'pending',
        NOW,
        EXPIRED
      );
      const deleted = await store.purgeExpired(NOW);
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect(await store.getCode('purge-me')).toBeNull();
      expect((await store.getCode('code-1'))?.code).toBe('code-1');
    });
  });
});
