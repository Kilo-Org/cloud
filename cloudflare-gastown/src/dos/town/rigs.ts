/**
 * Rig registry for the Town DO.
 * Rigs are now SQL rows in the Town DO instead of KV entries.
 */

import { z } from 'zod';
import { query } from '../../util/query.util';

const RIG_TABLE_CREATE = /* sql */ `
  CREATE TABLE IF NOT EXISTS "rigs" (
    "id" TEXT PRIMARY KEY,
    "name" TEXT NOT NULL,
    "git_url" TEXT NOT NULL DEFAULT '',
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "config" TEXT DEFAULT '{}',
    "created_at" TEXT NOT NULL
  )
`;

const RIG_INDEX = /* sql */ `CREATE UNIQUE INDEX IF NOT EXISTS idx_rigs_name ON rigs(name)`;

export const RigRecord = z.object({
  id: z.string(),
  name: z.string(),
  git_url: z.string(),
  default_branch: z.string(),
  config: z
    .string()
    .transform(v => JSON.parse(v))
    .pipe(z.record(z.string(), z.unknown())),
  created_at: z.string(),
});

export type RigRecord = z.output<typeof RigRecord>;

export function initRigTables(sql: SqlStorage): void {
  query(sql, RIG_TABLE_CREATE, []);
  query(sql, RIG_INDEX, []);
}

export function addRig(
  sql: SqlStorage,
  input: {
    rigId: string;
    name: string;
    gitUrl: string;
    defaultBranch: string;
  }
): RigRecord {
  const timestamp = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      INSERT OR REPLACE INTO rigs (id, name, git_url, default_branch, config, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [input.rigId, input.name, input.gitUrl, input.defaultBranch, '{}', timestamp]
  );

  const rig = getRig(sql, input.rigId);
  if (!rig) throw new Error('Failed to create rig');
  return rig;
}

export function getRig(sql: SqlStorage, rigId: string): RigRecord | null {
  const rows = [...query(sql, /* sql */ `SELECT * FROM rigs WHERE id = ?`, [rigId])];
  if (rows.length === 0) return null;
  return RigRecord.parse(rows[0]);
}

export function listRigs(sql: SqlStorage): RigRecord[] {
  const rows = [...query(sql, /* sql */ `SELECT * FROM rigs ORDER BY created_at ASC`, [])];
  return RigRecord.array().parse(rows);
}

export function removeRig(sql: SqlStorage, rigId: string): void {
  query(sql, /* sql */ `DELETE FROM rigs WHERE id = ?`, [rigId]);
}
