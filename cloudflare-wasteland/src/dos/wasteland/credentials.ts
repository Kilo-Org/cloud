import { query } from '../../util/query.util';
import {
  wasteland_credentials,
  WastelandCredentialRecord,
  createTableWastelandCredentials,
} from '../../db/tables/wasteland-credentials.table';

export function initCredentialTable(sql: SqlStorage): void {
  query(sql, createTableWastelandCredentials(), []);
}

export function storeCredential(
  sql: SqlStorage,
  userId: string,
  encryptedToken: string,
  dolthubOrg: string,
  rigHandle?: string
): WastelandCredentialRecord {
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

  const result = getCredential(sql, userId);
  if (!result) throw new Error('Failed to read credential after insert');
  return result;
}

export function getCredential(
  sql: SqlStorage,
  userId: string
): WastelandCredentialRecord | null {
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
    /* sql */ `DELETE FROM ${wasteland_credentials} WHERE ${wasteland_credentials.user_id} = ?`,
    [userId]
  );
}
