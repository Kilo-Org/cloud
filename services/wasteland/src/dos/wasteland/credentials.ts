import { isSameDolthubOrg } from '@kilocode/wl-sdk';
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
  // Only a verified flow (join, createUpstream) may set the handle. A
  // caller that does not supply one — a reconnect that swaps the token
  // — keeps the stored handle while it still belongs to the same org,
  // because that handle was proved against that org. An org change
  // drops it instead of carrying an identity over to another org; it
  // stays null until a verified flow sets it.
  const existing = input.rigHandle === undefined ? getCredential(sql, wastelandId, userId) : null;
  const keepsHandle = existing !== null && isSameDolthubOrg(existing.dolthub_org, input.dolthubOrg);
  const rigHandle = input.rigHandle ?? (keepsHandle ? existing.rig_handle : null);
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
    [userId, wastelandId, input.encryptedToken, input.dolthubOrg, rigHandle, isAdmin, timestamp]
  );

  return {
    user_id: userId,
    encrypted_token: input.encryptedToken,
    dolthub_org: input.dolthubOrg,
    rig_handle: rigHandle,
    is_upstream_admin: input.isUpstreamAdmin === true,
    connected_at: timestamp,
  };
}

/**
 * Whether a stored credential already proves `org` for its user.
 *
 * A rig handle is written only by flows that proved the org through a
 * DoltHub write — a join (fork created under the org, or a
 * registration write into its fork), or a `createUpstream` bootstrap
 * that wrote to that org's repository — and `storeCredential` drops the
 * handle when the org changes. So a handle recorded together with this
 * same org stands for that proof.
 */
export function credentialProvesOrg(
  credential: WastelandCredentialResult | null,
  org: string
): boolean {
  return (
    credential !== null &&
    credential.rig_handle !== null &&
    isSameDolthubOrg(credential.dolthub_org, org)
  );
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
