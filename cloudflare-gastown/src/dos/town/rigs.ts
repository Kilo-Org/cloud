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
    .transform((v): Record<string, unknown> => {
      try {
        return JSON.parse(v) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
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
  try {
    query(
      sql,
      /* sql */ `
        INSERT INTO rigs (id, name, git_url, default_branch, config, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          git_url = excluded.git_url,
          default_branch = excluded.default_branch
      `,
      [input.rigId, input.name, input.gitUrl, input.defaultBranch, '{}', timestamp]
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: rigs.name')) {
      // A rig with this name already exists under a different ID.
      // Clean up the stale entry only if it's truly orphaned (has no
      // open or in-progress beads). Otherwise surface the conflict.
      const staleRig = query(sql, /* sql */ `SELECT id FROM rigs WHERE name = ? AND id != ?`, [
        input.name,
        input.rigId,
      ]);
      const staleId = [...staleRig][0]?.id as string | undefined;
      if (staleId) {
        const activeBeads = query(
          sql,
          /* sql */ `SELECT COUNT(*) AS cnt FROM beads WHERE rig_id = ? AND status IN ('open', 'in_progress')`,
          [staleId]
        );
        const count = Number([...activeBeads][0]?.cnt ?? 0);
        if (count > 0) {
          throw new Error(
            `A rig named "${input.name}" already exists (id=${staleId}) with ${count} active bead(s). ` +
              `Delete it first before creating a new rig with the same name.`
          );
        }
        // Truly orphaned — safe to remove
        query(sql, /* sql */ `DELETE FROM rigs WHERE id = ?`, [staleId]);
      }
      query(
        sql,
        /* sql */ `
          INSERT INTO rigs (id, name, git_url, default_branch, config, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            git_url = excluded.git_url,
            default_branch = excluded.default_branch
        `,
        [input.rigId, input.name, input.gitUrl, input.defaultBranch, '{}', timestamp]
      );
    } else {
      throw err;
    }
  }

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
