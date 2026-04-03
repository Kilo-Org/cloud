/**
 * Encrypted DoltHub token storage.
 * Each user stores their DoltHub API token encrypted at rest.
 */

import { query } from '../../util/query.util';
import {
  wasteland_credentials,
  WastelandCredentialRecord,
  createTableWastelandCredentials,
} from '../../db/tables/wasteland-credentials.table';

export type WastelandCredential = WastelandCredentialRecord;

function now(): string {
  return new Date().toISOString();
}

export function initCredentialTables(sql: SqlStorage): void {
  query(sql, createTableWastelandCredentials(), []);
}

export function storeCredential(
  sql: SqlStorage,
  userId: string,
  encryptedToken: string,
  dolthubOrg: string,
  rigHandle?: string | null
): WastelandCredential {
  const timestamp = now();
  query(
    sql,
    /* sql */ `
      INSERT INTO ${wasteland_credentials} (
        ${wasteland_credentials.columns.user_id},
        ${wasteland_credentials.columns.encrypted_token},
        ${wasteland_credentials.columns.dolthub_org},
        ${wasteland_credentials.columns.rig_handle},
        ${wasteland_credentials.columns.connected_at}
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(${wasteland_credentials.columns.user_id}) DO UPDATE SET
        ${wasteland_credentials.columns.encrypted_token} = excluded.${wasteland_credentials.columns.encrypted_token},
        ${wasteland_credentials.columns.dolthub_org} = excluded.${wasteland_credentials.columns.dolthub_org},
        ${wasteland_credentials.columns.rig_handle} = excluded.${wasteland_credentials.columns.rig_handle},
        ${wasteland_credentials.columns.connected_at} = excluded.${wasteland_credentials.columns.connected_at}
    `,
    [userId, encryptedToken, dolthubOrg, rigHandle ?? null, timestamp]
  );

  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_credentials} WHERE ${wasteland_credentials.user_id} = ?`,
      [userId]
    ),
  ];
  return WastelandCredentialRecord.parse(rows[0]);
}

export function getCredential(sql: SqlStorage, userId: string): WastelandCredential | null {
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

export function listCredentials(sql: SqlStorage): WastelandCredential[] {
  const rows = [
    ...query(
      sql,
      /* sql */ `SELECT * FROM ${wasteland_credentials} ORDER BY ${wasteland_credentials.connected_at} ASC`,
      []
    ),
  ];
  return WastelandCredentialRecord.array().parse(rows);
}
