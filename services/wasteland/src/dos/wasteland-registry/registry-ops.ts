/**
 * Registry SQL operations — extracted as plain functions over
 * `SqlStorage` so they can be unit-tested without booting the full
 * Durable Object runtime (the vitest pool is Node, not Workers).
 *
 * The DO class in `../WastelandRegistry.do.ts` is a thin shell that
 * forwards every RPC method to one of these.
 *
 * `dolthub_upstream` is stored verbatim. Lookups are case-insensitive:
 * `findByOwnerRepo` lowercases both the input and the stored value via
 * SQL `lower()` before comparing. This matches DoltHub's own slug
 * casing rules.
 */
import { z } from 'zod';
import { query } from '../../util/query.util';
import {
  createTableWastelandRegistry,
  wasteland_registry,
  wastelandRegistryAlterStatements,
  wastelandRegistryCreateIndexStatements,
  WastelandRegistryRecord,
} from '../../db/tables/wasteland-registry.table';

const CountResult = z.object({ cnt: z.coerce.number() });

export type RegisterInput = {
  wasteland_id: string;
  owner_type: 'user' | 'org';
  owner_user_id: string | null;
  organization_id: string | null;
  name: string;
  dolthub_upstream: string | null;
};

/** Run idempotent `CREATE TABLE`, ALTER, and CREATE INDEX statements. */
export function initialize(sql: SqlStorage): void {
  query(sql, createTableWastelandRegistry(), []);
  for (const stmt of wastelandRegistryAlterStatements) {
    try {
      sql.exec(stmt);
    } catch (err) {
      // SQLite raises "duplicate column name" when the column already
      // exists. There's no portable error code we can match — the
      // message text is the only signal — so fall back to a substring
      // probe and re-throw anything else.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column|already exists/i.test(msg)) throw err;
    }
  }
  for (const stmt of wastelandRegistryCreateIndexStatements) {
    sql.exec(stmt);
  }
}

export function register(sql: SqlStorage, input: RegisterInput, nowIso: string): void {
  query(
    sql,
    /* sql */ `
      INSERT OR REPLACE INTO ${wasteland_registry} (
        ${wasteland_registry.columns.wasteland_id},
        ${wasteland_registry.columns.owner_type},
        ${wasteland_registry.columns.owner_user_id},
        ${wasteland_registry.columns.organization_id},
        ${wasteland_registry.columns.name},
        ${wasteland_registry.columns.dolthub_upstream},
        ${wasteland_registry.columns.created_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.wasteland_id,
      input.owner_type,
      input.owner_user_id,
      input.organization_id,
      input.name,
      input.dolthub_upstream,
      nowIso,
    ]
  );
}

export function unregister(sql: SqlStorage, wastelandId: string): void {
  query(
    sql,
    /* sql */ `DELETE FROM ${wasteland_registry} WHERE ${wasteland_registry.wasteland_id} = ?`,
    [wastelandId]
  );
}

export function setDolthubUpstream(
  sql: SqlStorage,
  wastelandId: string,
  dolthubUpstream: string | null
): void {
  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_registry}
      SET ${wasteland_registry.columns.dolthub_upstream} = ?
      WHERE ${wasteland_registry.wasteland_id} = ?
    `,
    [dolthubUpstream, wastelandId]
  );
}

export function listByUser(sql: SqlStorage, userId: string): WastelandRegistryRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_registry}
        WHERE ${wasteland_registry.owner_type} = 'user'
          AND ${wasteland_registry.owner_user_id} = ?
        ORDER BY ${wasteland_registry.created_at} DESC
      `,
      [userId]
    ),
  ];
  return WastelandRegistryRecord.array().parse(rows);
}

export function listByOrg(sql: SqlStorage, orgId: string): WastelandRegistryRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_registry}
        WHERE ${wasteland_registry.owner_type} = 'org'
          AND ${wasteland_registry.organization_id} = ?
        ORDER BY ${wasteland_registry.created_at} DESC
      `,
      [orgId]
    ),
  ];
  return WastelandRegistryRecord.array().parse(rows);
}

export function listAll(sql: SqlStorage): WastelandRegistryRecord[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_registry}
        ORDER BY ${wasteland_registry.created_at} DESC
      `,
      []
    ),
  ];
  return WastelandRegistryRecord.array().parse(rows);
}

export function countAll(sql: SqlStorage): number {
  const rows = [...query(sql, /* sql */ `SELECT COUNT(*) AS cnt FROM ${wasteland_registry}`, [])];
  return CountResult.parse(rows[0]).cnt;
}

export function findByOwnerRepo(
  sql: SqlStorage,
  owner: string,
  repo: string
): WastelandRegistryRecord | null {
  // Compose `<owner>/<repo>` and compare case-insensitively. DoltHub
  // slugs use lowercase by convention but stored values may have
  // mixed case from older flows; using `lower()` on both sides keeps
  // the lookup robust without a DB migration.
  const target = `${owner}/${repo}`;
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_registry}
        WHERE lower(${wasteland_registry.dolthub_upstream}) = lower(?)
        ORDER BY ${wasteland_registry.created_at} DESC
        LIMIT 1
      `,
      [target]
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandRegistryRecord.parse(rows[0]);
}
