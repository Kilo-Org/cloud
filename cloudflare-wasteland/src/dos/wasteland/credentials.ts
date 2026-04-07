import { query } from '../../util/query.util';
import {
  createTableWastelandCredentials,
  wasteland_credentials,
  WastelandCredentialRecord,
} from '../../db/tables/wasteland-credentials.table';

export type WastelandCredentialResult = {
  user_id: string;
  encrypted_token: string;
  dolthub_org: string;
  rig_handle: string | null;
  connected_at: string;
};

export function initializeDatabase(sql: SqlStorage): void {
  query(sql, createTableWastelandCredentials(), []);
}

export function storeCredential(
  sql: SqlStorage,
  wastelandId: string,
  userId: string,
  encryptedToken: string,
  dolthubOrg: string,
  rigHandle?: string
): WastelandCredentialResult {
  const timestamp = new Date().toISOString();
  query(
    sql,
    /* sql */ `
      INSERT OR REPLACE INTO ${wasteland_credentials} (
        ${wasteland_credentials.columns.user_id},
        ${wasteland_credentials.columns.wasteland_id},
        ${wasteland_credentials.columns.encrypted_token},
        ${wasteland_credentials.columns.dolthub_org},
        ${wasteland_credentials.columns.rig_handle},
        ${wasteland_credentials.columns.connected_at}
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [userId, wastelandId, encryptedToken, dolthubOrg, rigHandle ?? null, timestamp]
  );

  return {
    user_id: userId,
    encrypted_token: encryptedToken,
    dolthub_org: dolthubOrg,
    rig_handle: rigHandle ?? null,
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
  return WastelandCredentialRecord.parse(rows[0]);
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
