import { z } from 'zod';
import { getTableFromZodSchema, getCreateTableQueryFromTable } from '../../util/table';
import { query } from '../../util/query.util';

// ── Schema & Table ──────────────────────────────────────────────────────

export const WastelandCredentialRecord = z.object({
  user_id: z.string(),
  encrypted_token: z.string(),
  dolthub_org: z.string(),
  rig_handle: z.string().nullable(),
  connected_at: z.string(),
});

export type WastelandCredentialRecord = z.output<typeof WastelandCredentialRecord>;

export const wasteland_credentials = getTableFromZodSchema(
  'wasteland_credentials',
  WastelandCredentialRecord
);

export function createTableWastelandCredentials(): string {
  return getCreateTableQueryFromTable(wasteland_credentials, {
    user_id: `TEXT PRIMARY KEY`,
    encrypted_token: `TEXT NOT NULL`,
    dolthub_org: `TEXT NOT NULL`,
    rig_handle: `TEXT`,
    connected_at: `TEXT NOT NULL DEFAULT (datetime('now'))`,
  });
}

// ── Operations ──────────────────────────────────────────────────────────

export function storeCredential(
  sql: SqlStorage,
  userId: string,
  encryptedToken: string,
  dolthubOrg: string,
  rigHandle?: string
): void {
  const timestamp = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      INSERT OR REPLACE INTO ${wasteland_credentials} (
        ${wasteland_credentials.columns.user_id},
        ${wasteland_credentials.columns.encrypted_token},
        ${wasteland_credentials.columns.dolthub_org},
        ${wasteland_credentials.columns.rig_handle},
        ${wasteland_credentials.columns.connected_at}
      ) VALUES (?, ?, ?, ?, ?)
    `,
    [userId, encryptedToken, dolthubOrg, rigHandle ?? null, timestamp]
  );
}

export function getCredential(sql: SqlStorage, userId: string): WastelandCredentialRecord | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_credentials}
        WHERE ${wasteland_credentials.user_id} = ?
      `,
      [userId]
    ),
  ];
  if (rows.length === 0) return null;
  return WastelandCredentialRecord.parse(rows[0]);
}

export function deleteCredential(sql: SqlStorage, userId: string): void {
  query(
    sql,
    /* sql */ `
      DELETE FROM ${wasteland_credentials}
      WHERE ${wasteland_credentials.user_id} = ?
    `,
    [userId]
  );
}
