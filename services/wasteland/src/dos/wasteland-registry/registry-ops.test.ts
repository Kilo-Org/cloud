import { describe, expect, it } from 'vitest';
import * as registryOps from './registry-ops';
import type { RegisterInput } from './registry-ops';

/**
 * Minimal in-memory `SqlStorage` shim. Only models the verbs the
 * registry actually issues — CREATE TABLE / CREATE INDEX / ALTER /
 * INSERT / UPDATE / DELETE / SELECT — by inspecting the query string
 * with regexes. The goal is to exercise the registry-ops module
 * end-to-end without booting a Durable Object (the vitest pool runs
 * in Node, which can't load `cloudflare:workers`).
 *
 * Behaviour matches SQLite where it matters for these tests:
 *   - case-insensitive `lower()` comparisons (mirrors the upstream
 *     lookup) implemented via JS `.toLowerCase()`.
 *   - duplicate `ALTER TABLE ... ADD COLUMN` raises an error whose
 *     message contains "duplicate column", which `initialize()` swallows.
 */
type Row = {
  wasteland_id: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  name: string;
  dolthub_upstream: string | null;
  created_at: string;
};

class FakeCursor<T> {
  constructor(private rows: T[]) {}
  toArray() {
    return this.rows;
  }
  *[Symbol.iterator]() {
    yield* this.rows;
  }
}

class FakeSqlStorage {
  rows: Row[] = [];
  hasUpstreamColumn = false;

  exec(sql: string, ...bindings: unknown[]): FakeCursor<Record<string, unknown>> {
    const trimmed = sql.trim();

    if (/^create table/i.test(trimmed)) {
      // The CREATE TABLE statement always includes the upstream column
      // because registry-ops emits the full schema. Tracking the flag
      // makes ALTER idempotency match SQLite's behaviour.
      this.hasUpstreamColumn = true;
      return new FakeCursor([]);
    }

    if (/^create index/i.test(trimmed)) {
      return new FakeCursor([]);
    }

    if (/^alter table .* add column/i.test(trimmed)) {
      if (this.hasUpstreamColumn) {
        throw new Error('duplicate column name: dolthub_upstream');
      }
      this.hasUpstreamColumn = true;
      return new FakeCursor([]);
    }

    if (/^insert or replace into/i.test(trimmed)) {
      const [
        wasteland_id,
        owner_type,
        owner_user_id,
        organization_id,
        name,
        dolthub_upstream,
        created_at,
      ] = bindings as [
        string,
        'user' | 'org',
        string | null,
        string | null,
        string,
        string | null,
        string,
      ];
      const next: Row = {
        wasteland_id,
        owner_type,
        owner_user_id,
        organization_id,
        name,
        dolthub_upstream,
        created_at,
      };
      const idx = this.rows.findIndex(r => r.wasteland_id === wasteland_id);
      if (idx >= 0) this.rows[idx] = next;
      else this.rows.push(next);
      return new FakeCursor([]);
    }

    if (
      /^update wasteland_registry/i.test(trimmed) ||
      /^update "wasteland_registry"/i.test(trimmed)
    ) {
      // Registry only updates dolthub_upstream by wasteland_id.
      const [dolthub_upstream, wasteland_id] = bindings as [string | null, string];
      const row = this.rows.find(r => r.wasteland_id === wasteland_id);
      if (row) row.dolthub_upstream = dolthub_upstream;
      return new FakeCursor([]);
    }

    if (/^delete from/i.test(trimmed)) {
      const [wasteland_id] = bindings as [string];
      this.rows = this.rows.filter(r => r.wasteland_id !== wasteland_id);
      return new FakeCursor([]);
    }

    if (/^select count/i.test(trimmed)) {
      return new FakeCursor([{ cnt: this.rows.length }]);
    }

    if (/^select \* from/i.test(trimmed)) {
      const [binding] = bindings as [string];
      let rows = this.rows;

      if (/lower\(.*dolthub_upstream\)/i.test(trimmed)) {
        rows = rows.filter(
          r =>
            r.dolthub_upstream !== null &&
            r.dolthub_upstream.toLowerCase() === binding.toLowerCase()
        );
      } else if (/owner_type\s*=\s*'user'/i.test(trimmed)) {
        rows = rows.filter(r => r.owner_type === 'user' && r.owner_user_id === binding);
      } else if (/owner_type\s*=\s*'org'/i.test(trimmed)) {
        rows = rows.filter(r => r.owner_type === 'org' && r.organization_id === binding);
      }

      // Apply the statement's own ordering and limit so a change to the
      // query changes the result instead of being masked by the shim.
      const ordered = applyOrderBy(trimmed, rows);
      return new FakeCursor(applyLimit(trimmed, ordered) as unknown as Record<string, unknown>[]);
    }

    throw new Error(`FakeSqlStorage: unhandled query\n${sql}`);
  }
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Honour `ORDER BY <column> [ASC|DESC]`. Only the columns this module
 * orders by are modelled; anything else fails loudly rather than
 * returning an order the test would silently accept.
 */
function applyOrderBy(sql: string, rows: Row[]): Row[] {
  const order = /order by\s+(?:\w+\.)?(\w+)(?:\s+(asc|desc))?/i.exec(sql);
  if (!order) return rows;

  const [, column, direction] = order;
  const compare = (a: Row, b: Row) => {
    if (column === 'created_at') return compareText(a.created_at, b.created_at);
    if (column === 'wasteland_id') return compareText(a.wasteland_id, b.wasteland_id);
    throw new Error(`FakeSqlStorage: unsupported ORDER BY column ${column}`);
  };

  const descending = (direction ?? '').toLowerCase() === 'desc';
  return [...rows].sort((a, b) => (descending ? compare(b, a) : compare(a, b)));
}

function applyLimit(sql: string, rows: Row[]): Row[] {
  const limit = /\blimit\s+(\d+)/i.exec(sql);
  if (!limit) return rows;
  return rows.slice(0, Number(limit[1]));
}

function freshSql() {
  const sql = new FakeSqlStorage() as unknown as SqlStorage;
  registryOps.initialize(sql);
  return sql;
}

function input(overrides: Partial<RegisterInput> = {}): RegisterInput {
  return {
    wasteland_id: 'wl-1',
    owner_type: 'user',
    owner_user_id: 'user-1',
    organization_id: null,
    name: 'demo',
    dolthub_upstream: 'octo/repo',
    ...overrides,
  };
}

describe('registry-ops', () => {
  describe('initialize', () => {
    it('is idempotent across boots', () => {
      const sql = freshSql();
      // Running initialize again should not throw — the duplicate
      // ALTER is swallowed and the CREATE INDEX uses IF NOT EXISTS.
      expect(() => registryOps.initialize(sql)).not.toThrow();
    });
  });

  describe('register + findAllByOwnerRepo', () => {
    it('finds a registered wasteland by owner/repo', () => {
      const sql = freshSql();
      registryOps.register(sql, input({ dolthub_upstream: 'octo/repo' }), '2025-01-01T00:00:00Z');
      const found = registryOps.findAllByOwnerRepo(sql, 'octo', 'repo');
      expect(found.map(r => r.wasteland_id)).toEqual(['wl-1']);
      expect(found[0]?.dolthub_upstream).toBe('octo/repo');
    });

    it('matches case-insensitively', () => {
      const sql = freshSql();
      registryOps.register(
        sql,
        input({ dolthub_upstream: 'OctoCat/Repo' }),
        '2025-01-01T00:00:00Z'
      );
      expect(
        registryOps.findAllByOwnerRepo(sql, 'octocat', 'repo').map(r => r.wasteland_id)
      ).toEqual(['wl-1']);
      expect(
        registryOps.findAllByOwnerRepo(sql, 'OCTOCAT', 'REPO').map(r => r.wasteland_id)
      ).toEqual(['wl-1']);
    });

    it('returns nothing for an unknown owner/repo', () => {
      const sql = freshSql();
      registryOps.register(sql, input({ dolthub_upstream: 'octo/repo' }), '2025-01-01T00:00:00Z');
      expect(registryOps.findAllByOwnerRepo(sql, 'nope', 'missing')).toEqual([]);
    });

    it('does not match wastelands without an upstream', () => {
      const sql = freshSql();
      registryOps.register(sql, input({ dolthub_upstream: null }), '2025-01-01T00:00:00Z');
      expect(registryOps.findAllByOwnerRepo(sql, 'octo', 'repo')).toEqual([]);
    });

    it('returns every claimant of a shared upstream in primary-key order', () => {
      const sql = freshSql();
      registryOps.register(
        sql,
        input({ wasteland_id: 'wl-b', owner_user_id: 'user-2' }),
        '2025-06-01T00:00:00Z'
      );
      registryOps.register(
        sql,
        input({ wasteland_id: 'wl-a', owner_user_id: 'user-1' }),
        '2025-01-01T00:00:00Z'
      );

      expect(registryOps.findAllByOwnerRepo(sql, 'octo', 'repo').map(r => r.wasteland_id)).toEqual([
        'wl-a',
        'wl-b',
      ]);
    });

    it('keeps the order when a claimant is re-registered', () => {
      const sql = freshSql();
      registryOps.register(
        sql,
        input({ wasteland_id: 'wl-a', owner_user_id: 'user-1' }),
        '2025-01-01T00:00:00Z'
      );
      registryOps.register(
        sql,
        input({ wasteland_id: 'wl-b', owner_user_id: 'user-2' }),
        '2025-06-01T00:00:00Z'
      );

      registryOps.register(
        sql,
        input({ wasteland_id: 'wl-a', owner_user_id: 'user-1' }),
        '2025-12-31T00:00:00Z'
      );

      expect(registryOps.findAllByOwnerRepo(sql, 'octo', 'repo').map(r => r.wasteland_id)).toEqual([
        'wl-a',
        'wl-b',
      ]);
    });
  });

  describe('unregister', () => {
    it('removes the lookup', () => {
      const sql = freshSql();
      registryOps.register(sql, input({ dolthub_upstream: 'octo/repo' }), '2025-01-01T00:00:00Z');
      registryOps.unregister(sql, 'wl-1');
      expect(registryOps.findAllByOwnerRepo(sql, 'octo', 'repo')).toEqual([]);
      expect(registryOps.countAll(sql)).toBe(0);
    });
  });

  describe('setDolthubUpstream', () => {
    it('updates the lookup so the old slug no longer matches', () => {
      const sql = freshSql();
      registryOps.register(sql, input({ dolthub_upstream: 'octo/old' }), '2025-01-01T00:00:00Z');
      registryOps.setDolthubUpstream(sql, 'wl-1', 'octo/new');

      expect(registryOps.findAllByOwnerRepo(sql, 'octo', 'old')).toEqual([]);
      const next = registryOps.findAllByOwnerRepo(sql, 'octo', 'new');
      expect(next.map(r => r.wasteland_id)).toEqual(['wl-1']);
      expect(next[0]?.dolthub_upstream).toBe('octo/new');
    });

    it('clears the upstream when set to null', () => {
      const sql = freshSql();
      registryOps.register(sql, input({ dolthub_upstream: 'octo/repo' }), '2025-01-01T00:00:00Z');
      registryOps.setDolthubUpstream(sql, 'wl-1', null);
      expect(registryOps.findAllByOwnerRepo(sql, 'octo', 'repo')).toEqual([]);
      const all = registryOps.listAll(sql);
      expect(all).toHaveLength(1);
      expect(all[0]?.dolthub_upstream).toBeNull();
    });
  });

  describe('listByUser / listByOrg / countAll', () => {
    it('filters by owner type', () => {
      const sql = freshSql();
      registryOps.register(
        sql,
        input({ wasteland_id: 'wl-user', owner_type: 'user', owner_user_id: 'u1' }),
        '2025-01-01T00:00:00Z'
      );
      registryOps.register(
        sql,
        input({
          wasteland_id: 'wl-org',
          owner_type: 'org',
          owner_user_id: null,
          organization_id: 'org1',
        }),
        '2025-01-02T00:00:00Z'
      );
      expect(registryOps.listByUser(sql, 'u1').map(r => r.wasteland_id)).toEqual(['wl-user']);
      expect(registryOps.listByOrg(sql, 'org1').map(r => r.wasteland_id)).toEqual(['wl-org']);
      expect(registryOps.countAll(sql)).toBe(2);
    });
  });
});
