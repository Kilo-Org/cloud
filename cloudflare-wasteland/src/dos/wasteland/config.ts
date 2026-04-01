import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';
import { query } from '../../util/query.util';

// ── Schema & Table ──────────────────────────────────────────────────────

export const WastelandConfigRecord = z.object({
  wasteland_id: z.string(),
  name: z.string(),
  owner_type: z.enum(['user', 'org']),
  owner_user_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  dolthub_upstream: z.string().nullable(),
  visibility: z.enum(['public', 'private']),
  status: z.enum(['active', 'deleted']),
  created_at: z.string(),
  updated_at: z.string(),
});

export type WastelandConfigRecord = z.output<typeof WastelandConfigRecord>;

export const wasteland_config = getTableFromZodSchema('wasteland_config', WastelandConfigRecord);

export function createTableWastelandConfig(): string {
  return getCreateTableQueryFromTable(wasteland_config, {
    wasteland_id: `TEXT PRIMARY KEY`,
    name: `TEXT NOT NULL`,
    owner_type: `TEXT NOT NULL CHECK(owner_type IN ('user', 'org'))`,
    owner_user_id: `TEXT`,
    organization_id: `TEXT`,
    dolthub_upstream: `TEXT`,
    visibility: `TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('public', 'private'))`,
    status: `TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted'))`,
    created_at: `TEXT NOT NULL DEFAULT (datetime('now'))`,
    updated_at: `TEXT NOT NULL DEFAULT (datetime('now'))`,
  });
}

// ── Types ───────────────────────────────────────────────────────────────

export type InitWastelandInput = {
  wasteland_id: string;
  name: string;
  owner_type: 'user' | 'org';
  owner_user_id?: string;
  organization_id?: string;
  dolthub_upstream?: string;
  visibility?: 'public' | 'private';
};

// ── Operations ──────────────────────────────────────────────────────────

export function getConfig(sql: SqlStorage): WastelandConfigRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_config} LIMIT 1`,
      []
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandConfigRecord.parse(rows[0]);
}

export function initializeWasteland(sql: SqlStorage, input: InitWastelandInput): void {
  const timestamp = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      INSERT INTO ${wasteland_config} (
        ${wasteland_config.columns.wasteland_id},
        ${wasteland_config.columns.name},
        ${wasteland_config.columns.owner_type},
        ${wasteland_config.columns.owner_user_id},
        ${wasteland_config.columns.organization_id},
        ${wasteland_config.columns.dolthub_upstream},
        ${wasteland_config.columns.visibility},
        ${wasteland_config.columns.status},
        ${wasteland_config.columns.created_at},
        ${wasteland_config.columns.updated_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `,
    [
      input.wasteland_id,
      input.name,
      input.owner_type,
      input.owner_user_id ?? null,
      input.organization_id ?? null,
      input.dolthub_upstream ?? null,
      input.visibility ?? 'private',
      timestamp,
      timestamp,
    ]
  );
}

export function updateConfig(
  sql: SqlStorage,
  wastelandId: string,
  update: Partial<Pick<WastelandConfigRecord, 'name' | 'visibility' | 'dolthub_upstream' | 'status'>>
): void {
  const timestamp = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_config}
      SET
        ${wasteland_config.columns.name} = COALESCE(?, ${wasteland_config.columns.name}),
        ${wasteland_config.columns.visibility} = COALESCE(?, ${wasteland_config.columns.visibility}),
        ${wasteland_config.columns.dolthub_upstream} = COALESCE(?, ${wasteland_config.columns.dolthub_upstream}),
        ${wasteland_config.columns.status} = COALESCE(?, ${wasteland_config.columns.status}),
        ${wasteland_config.columns.updated_at} = ?
      WHERE ${wasteland_config.wasteland_id} = ?
    `,
    [
      update.name ?? null,
      update.visibility ?? null,
      update.dolthub_upstream ?? null,
      update.status ?? null,
      timestamp,
      wastelandId,
    ]
  );
}
