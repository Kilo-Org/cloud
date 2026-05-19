import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DrizzleOrm from 'drizzle-orm';

type Row = {
  id: string;
  user_id: string;
  sandbox_id: string;
  destroyed_at: string | null;
};

type Predicate = (row: Row) => boolean;

const dbState = vi.hoisted(() => ({
  rows: [] as Row[],
  queryCount: 0,
}));

vi.unmock('../services/sandbox-ownership');

// Replace drizzle's expression helpers with predicate factories so the test
// mock can actually evaluate the WHERE clause against `dbState.rows` instead
// of silently returning every row regardless of the query.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof DrizzleOrm>('drizzle-orm');
  type ColRef = { name: string };
  type MaybePred = Predicate | undefined;
  return {
    ...actual,
    eq:
      (col: ColRef, val: unknown): Predicate =>
      row =>
        (row as unknown as Record<string, unknown>)[col.name] === val,
    isNull:
      (col: ColRef): Predicate =>
      row =>
        (row as unknown as Record<string, unknown>)[col.name] === null,
    and:
      (...preds: MaybePred[]): Predicate =>
      row =>
        preds.every(p => !p || p(row)),
    or:
      (...preds: MaybePred[]): Predicate =>
      row =>
        preds.some(p => !!p && p(row)),
  };
});

vi.mock('@kilocode/db', () => ({
  getWorkerDb: () => ({
    select: (selection: Record<string, { name: string }>) => ({
      from: () => ({
        where: (predicate: Predicate | undefined) => ({
          limit: async (limit: number) => {
            dbState.queryCount += 1;
            const matched = predicate ? dbState.rows.filter(row => predicate(row)) : dbState.rows;
            return matched.slice(0, limit).map(row => {
              const out: Record<string, unknown> = {};
              for (const [key, col] of Object.entries(selection)) {
                out[key] = (row as unknown as Record<string, unknown>)[col.name];
              }
              return out;
            });
          },
        }),
      }),
    }),
  }),
}));

const env = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
} as Env;

const LEGACY_SANDBOX_ID = 'ZTQ0YWM3NGMtZmJkOC00OTc2LTkyZmUtNGQ2NmIzMDg4MDll';
const INSTANCE_UUID = 'f94cb138-03d6-44a5-a8d8-6514fc947dad';
const INSTANCE_KEYED_SANDBOX_ID = 'ki_f94cb13803d644a5a8d86514fc947dad';

const { lookupSandboxOwnerUserId, userOwnsSandbox } = await import('../services/sandbox-ownership');

describe('sandbox ownership lookups', () => {
  beforeEach(() => {
    dbState.rows = [];
    dbState.queryCount = 0;
  });

  describe('userOwnsSandbox', () => {
    it('accepts exact sandbox_id match', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: 'sandbox-1',
          destroyed_at: null,
        },
      ];
      await expect(userOwnsSandbox(env, 'user-1', 'sandbox-1')).resolves.toBe(true);
    });

    it('rejects when no row matches', async () => {
      await expect(userOwnsSandbox(env, 'user-1', 'sandbox-1')).resolves.toBe(false);
    });

    it('does not reuse a positive ownership result after the instance is destroyed', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: 'sandbox-1',
          destroyed_at: null,
        },
      ];
      await expect(userOwnsSandbox(env, 'user-1', 'sandbox-1')).resolves.toBe(true);

      dbState.rows = [];
      await expect(userOwnsSandbox(env, 'user-1', 'sandbox-1')).resolves.toBe(false);
      expect(dbState.queryCount).toBe(2);
    });

    it('accepts ki_ form via id match when DB row still stores the legacy sandbox_id', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: LEGACY_SANDBOX_ID,
          destroyed_at: null,
        },
      ];
      await expect(userOwnsSandbox(env, 'user-1', INSTANCE_KEYED_SANDBOX_ID)).resolves.toBe(true);
    });

    it('rejects ki_ form with non-hex content even when a row for the caller exists', async () => {
      // `isInstanceKeyedSandboxId` only checks prefix + length, so a 35-char
      // ki_ string of non-hex chars passes that test. `instanceIdFromSandboxId`
      // then formats it into a UUID-shaped string with non-hex chars, which
      // `isValidInstanceId` rejects — so the id-match branch must be skipped
      // and the caller-controlled value must not reach the uuid column.
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: LEGACY_SANDBOX_ID,
          destroyed_at: null,
        },
      ];
      await expect(
        userOwnsSandbox(env, 'user-1', 'ki_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')
      ).resolves.toBe(false);
    });

    it('rejects ki_ form referencing a row owned by another user', async () => {
      const otherInstanceUuid = '11111111-2222-3333-4444-555555555555';
      const otherKiSandboxId = 'ki_11111111222233334444555555555555';
      dbState.rows = [
        {
          id: otherInstanceUuid,
          user_id: 'user-2',
          sandbox_id: 'sandbox-of-user-2',
          destroyed_at: null,
        },
      ];
      await expect(userOwnsSandbox(env, 'user-1', otherKiSandboxId)).resolves.toBe(false);
    });

    it('rejects ki_ form when the matching row is destroyed', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: LEGACY_SANDBOX_ID,
          destroyed_at: '2026-01-01T00:00:00Z',
        },
      ];
      await expect(userOwnsSandbox(env, 'user-1', INSTANCE_KEYED_SANDBOX_ID)).resolves.toBe(false);
    });

    it('rejects legacy sandbox_id belonging to another user', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-2',
          sandbox_id: 'sandbox-of-user-2',
          destroyed_at: null,
        },
      ];
      await expect(userOwnsSandbox(env, 'user-1', 'sandbox-of-user-2')).resolves.toBe(false);
    });
  });

  describe('lookupSandboxOwnerUserId', () => {
    it('returns user_id for exact sandbox_id match', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: 'sandbox-1',
          destroyed_at: null,
        },
      ];
      await expect(lookupSandboxOwnerUserId(env, 'sandbox-1')).resolves.toBe('user-1');
    });

    it('returns null when no row matches', async () => {
      await expect(lookupSandboxOwnerUserId(env, 'sandbox-1')).resolves.toBeNull();
    });

    it('does not reuse a positive owner lookup after the instance is destroyed', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: 'sandbox-1',
          destroyed_at: null,
        },
      ];
      await expect(lookupSandboxOwnerUserId(env, 'sandbox-1')).resolves.toBe('user-1');

      dbState.rows = [];
      await expect(lookupSandboxOwnerUserId(env, 'sandbox-1')).resolves.toBeNull();
      expect(dbState.queryCount).toBe(2);
    });

    it('returns user_id for ki_ form via id match when DB row still stores legacy sandbox_id', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: LEGACY_SANDBOX_ID,
          destroyed_at: null,
        },
      ];
      await expect(lookupSandboxOwnerUserId(env, INSTANCE_KEYED_SANDBOX_ID)).resolves.toBe(
        'user-1'
      );
    });

    it('returns null for ki_ form with non-hex content', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: LEGACY_SANDBOX_ID,
          destroyed_at: null,
        },
      ];
      await expect(
        lookupSandboxOwnerUserId(env, 'ki_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')
      ).resolves.toBeNull();
    });

    it('returns null for ki_ form when the matching row is destroyed', async () => {
      dbState.rows = [
        {
          id: INSTANCE_UUID,
          user_id: 'user-1',
          sandbox_id: LEGACY_SANDBOX_ID,
          destroyed_at: '2026-01-01T00:00:00Z',
        },
      ];
      await expect(lookupSandboxOwnerUserId(env, INSTANCE_KEYED_SANDBOX_ID)).resolves.toBeNull();
    });
  });
});
