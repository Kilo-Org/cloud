import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';

export const WastelandCredentialRecord = z.object({
  user_id: z.string(),
  wasteland_id: z.string(),
  encrypted_token: z.string(),
  dolthub_org: z.string(),
  rig_handle: z.string().nullable(),
  // When true, the stored token has push access to the upstream — we
  // unlock "admin mode" (direct pushes, merge/accept controls). The user
  // sets this via an explicit checkbox on connect/settings; we don't
  // probe DoltHub to verify. SQLite stores booleans as 0/1 integers, so
  // we coerce on read.
  is_upstream_admin: z
    .union([z.boolean(), z.number(), z.null()])
    .transform(v => v === true || v === 1),
  connected_at: z.string(),
});

export type WastelandCredentialRecord = z.output<typeof WastelandCredentialRecord>;

export const wasteland_credentials = getTableFromZodSchema(
  'wasteland_credentials',
  WastelandCredentialRecord
);

export function createTableWastelandCredentials(): string {
  return getCreateTableQueryFromTable(wasteland_credentials, {
    user_id: `text primary key`,
    wasteland_id: `text not null`,
    encrypted_token: `text not null`,
    dolthub_org: `text not null`,
    rig_handle: `text`,
    is_upstream_admin: `integer not null default 0`,
    connected_at: `text not null default (datetime('now'))`,
  });
}

/**
 * Idempotent migration that adds `is_upstream_admin` to existing rows.
 * Safe to call on every DO init — SQLite's ALTER TABLE IF NOT EXISTS
 * isn't available, so we catch the "duplicate column" error via a
 * presence check.
 */
export function migrateAddIsUpstreamAdmin(sql: SqlStorage): void {
  const cols = [...sql.exec<{ name: string }>(`PRAGMA table_info(wasteland_credentials)`)];
  if (cols.some(c => c.name === 'is_upstream_admin')) return;
  sql.exec(
    `ALTER TABLE wasteland_credentials ADD COLUMN is_upstream_admin integer not null default 0`
  );
}
