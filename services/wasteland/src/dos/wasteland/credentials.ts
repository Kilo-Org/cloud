import { query } from '../../util/query.util';
import {
  createTableWastelandCredentials,
  migrateAddIsUpstreamAdmin,
  wasteland_credentials,
  WastelandCredentialRecord,
} from '../../db/tables/wasteland-credentials.table';

export type WastelandCredentialResult = {
  user_id: string;
  encrypted_token: string;
  dolthub_org: string;
  rig_handle: string | null;
  is_upstream_admin: boolean;
  connected_at: string;
};

export function initializeDatabase(sql: SqlStorage): void {
  query(sql, createTableWastelandCredentials(), []);
  migrateAddIsUpstreamAdmin(sql);
}

export function storeCredential(
  sql: SqlStorage,
  wastelandId: string,
  userId: string,
  input: {
    encryptedToken: string;
    dolthubOrg: string;
    rigHandle?: string;
    isUpstreamAdmin?: boolean;
  }
): WastelandCredentialResult {
  const timestamp = new Date().toISOString();
  const isAdmin = input.isUpstreamAdmin ? 1 : 0;
  query(
    sql,
    /* sql */ `
      INSERT OR REPLACE INTO ${wasteland_credentials} (
        ${wasteland_credentials.columns.user_id},
        ${wasteland_credentials.columns.wasteland_id},
        ${wasteland_credentials.columns.encrypted_token},
        ${wasteland_credentials.columns.dolthub_org},
        ${wasteland_credentials.columns.rig_handle},
        ${wasteland_credentials.columns.is_upstream_admin},
        ${wasteland_credentials.columns.connected_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      userId,
      wastelandId,
      input.encryptedToken,
      input.dolthubOrg,
      input.rigHandle ?? null,
      isAdmin,
      timestamp,
    ]
  );

  return {
    user_id: userId,
    encrypted_token: input.encryptedToken,
    dolthub_org: input.dolthubOrg,
    rig_handle: input.rigHandle ?? null,
    is_upstream_admin: input.isUpstreamAdmin === true,
    connected_at: timestamp,
  };
}

export function getCredential(
  sql: SqlStorage,
  wastelandId: string,
  userId: string
): WastelandCredentialResult | null {
  const rows = [
    ...query(
      sql,
      /* sql */ `
        SELECT * FROM ${wasteland_credentials}
        WHERE ${wasteland_credentials.columns.user_id} = ?
          AND ${wasteland_credentials.columns.wasteland_id} = ?
      `,
      [userId, wastelandId]
    ),
  ];
  if (rows.length === 0) return null;
  const parsed = WastelandCredentialRecord.parse(rows[0]);
  return {
    user_id: parsed.user_id,
    encrypted_token: parsed.encrypted_token,
    dolthub_org: parsed.dolthub_org,
    rig_handle: parsed.rig_handle,
    is_upstream_admin: parsed.is_upstream_admin,
    connected_at: parsed.connected_at,
  };
}

/**
 * Update the `is_upstream_admin` flag for an existing credential.
 * Returns the updated row, or null if no credential exists.
 */
export function setIsUpstreamAdmin(
  sql: SqlStorage,
  wastelandId: string,
  userId: string,
  isUpstreamAdmin: boolean
): WastelandCredentialResult | null {
  query(
    sql,
    /* sql */ `
      UPDATE ${wasteland_credentials}
      SET ${wasteland_credentials.columns.is_upstream_admin} = ?
      WHERE ${wasteland_credentials.columns.user_id} = ?
        AND ${wasteland_credentials.columns.wasteland_id} = ?
    `,
    [isUpstreamAdmin ? 1 : 0, userId, wastelandId]
  );
  return getCredential(sql, wastelandId, userId);
}

export function deleteCredential(sql: SqlStorage, wastelandId: string, userId: string): void {
  query(
    sql,
    /* sql */ `
      DELETE FROM ${wasteland_credentials}
      WHERE ${wasteland_credentials.columns.user_id} = ?
        AND ${wasteland_credentials.columns.wasteland_id} = ?
    `,
    [userId, wastelandId]
  );
}
