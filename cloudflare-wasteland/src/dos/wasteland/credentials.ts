/**
 * Credential management operations for WastelandDO.
 */
import { query } from '../../util/query.util';
import {
  createTableWastelandCredentials,
  wasteland_credentials,
  WastelandCredentialRecord,
} from '../../db/tables/wasteland-credentials.table';

export function initCredentialsTable(sql: SqlStorage): void {
  query(sql, createTableWastelandCredentials(), []);
}

export function storeCredential(
  sql: SqlStorage,
  userId: string,
  encryptedToken: string,
  dolthubOrg: string,
  rigHandle?: string
): WastelandCredentialRecord {
  const now = new Date().toISOString();
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
    [userId, encryptedToken, dolthubOrg, rigHandle ?? null, now]
  );

  const credential = getCredential(sql, userId);
  if (!credential) throw new Error('Failed to read credential after store');
  return credential;
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
  const parsed = WastelandCredentialRecord.array().parse(rows);
  return parsed[0] ?? null;
}

export function deleteCredential(sql: SqlStorage, userId: string): void {
  query(
    sql,
    /* sql */ `DELETE FROM ${wasteland_credentials} WHERE ${wasteland_credentials.user_id} = ?`,
    [userId]
  );
}
