import { isSameDolthubOrg } from '@kilocode/wl-sdk';
import { query } from '../../util/query.util';
import {
  createTableWastelandCredentials,
  migrateAddIsUpstreamAdmin,
  migrateAddProvenOrg,
  wasteland_credentials,
  WastelandCredentialRecord,
} from '../../db/tables/wasteland-credentials.table';

export type WastelandCredentialResult = {
  user_id: string;
  encrypted_token: string;
  dolthub_org: string;
  rig_handle: string | null;
  proven_org: string | null;
  is_upstream_admin: boolean;
  connected_at: string;
};

export function initializeDatabase(sql: SqlStorage): void {
  query(sql, createTableWastelandCredentials(), []);
  migrateAddIsUpstreamAdmin(sql);
  migrateAddProvenOrg(sql);
}

export function storeCredential(
  sql: SqlStorage,
  wastelandId: string,
  userId: string,
  input: {
    encryptedToken: string;
    dolthubOrg: string;
    rigHandle?: string;
    /**
     * The org a verified flow just established with DoltHub. Only the
     * worker's own flows pass it (a join after its registration write,
     * a bootstrap that wrote to the org's own repository); the public
     * `storeCredential` mutation never does.
     */
    provenOrg?: string;
    isUpstreamAdmin?: boolean;
  }
): WastelandCredentialResult {
  const timestamp = new Date().toISOString();
  const isAdmin = input.isUpstreamAdmin ? 1 : 0;
  // Only a verified flow (join, createUpstream) may set the handle. A
  // caller that does not supply one — a reconnect that swaps the token
  // — keeps the stored handle while the re-stored org is the one it was
  // recorded for, so long as this credential either proves that org or
  // records no proof at all. The second case is the shape rows written
  // before proofs existed have: no flow writes a handle without a proof
  // today, and dropping those handles would take an identity away from
  // users whose org the join cannot re-establish (a connection made
  // under a DoltHub organization). An org change drops the handle
  // instead of carrying an identity over to another org.
  const existing = input.rigHandle === undefined ? getCredential(sql, wastelandId, userId) : null;
  const keepsHandle =
    existing !== null &&
    isSameDolthubOrg(existing.dolthub_org, input.dolthubOrg) &&
    (existing.proven_org === null || credentialProvesOrg(existing, input.dolthubOrg));
  const rigHandle = input.rigHandle ?? (keepsHandle ? existing.rig_handle : null);
  // The proof travels with the org it was recorded for; it is set by a
  // verified flow only, and otherwise kept only while the org is
  // unchanged.
  const provenOrg =
    input.provenOrg !== undefined
      ? isSameDolthubOrg(input.provenOrg, input.dolthubOrg)
        ? input.dolthubOrg
        : null
      : existing !== null && isSameDolthubOrg(existing.proven_org, input.dolthubOrg)
        ? existing.proven_org
        : null;
  query(
    sql,
    /* sql */ `
      INSERT OR REPLACE INTO ${wasteland_credentials} (
        ${wasteland_credentials.columns.user_id},
        ${wasteland_credentials.columns.wasteland_id},
        ${wasteland_credentials.columns.encrypted_token},
        ${wasteland_credentials.columns.dolthub_org},
        ${wasteland_credentials.columns.rig_handle},
        ${wasteland_credentials.columns.proven_org},
        ${wasteland_credentials.columns.is_upstream_admin},
        ${wasteland_credentials.columns.connected_at}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      userId,
      wastelandId,
      input.encryptedToken,
      input.dolthubOrg,
      rigHandle,
      provenOrg,
      isAdmin,
      timestamp,
    ]
  );

  return {
    user_id: userId,
    encrypted_token: input.encryptedToken,
    dolthub_org: input.dolthubOrg,
    rig_handle: rigHandle,
    proven_org: provenOrg,
    is_upstream_admin: input.isUpstreamAdmin === true,
    connected_at: timestamp,
  };
}

/**
 * Whether a stored credential already proves `org` for its user.
 *
 * `proven_org` is written only by flows that established the org with a
 * DoltHub write — a join (fork created under it, or a registration
 * write into its fork), or a `createUpstream` bootstrap that wrote to
 * that org's own repository — and it is dropped when the org changes.
 * A credential with no recorded proof (including every row written
 * before this column existed) proves nothing.
 */
export function credentialProvesOrg(
  credential: WastelandCredentialResult | null,
  org: string
): boolean {
  return credential !== null && isSameDolthubOrg(credential.proven_org, org);
}

/**
 * The handle a caller's ops may present as their identity in a
 * wasteland — branch names, `claimed_by` / `posted_by`, stamp
 * authorship — for the org those ops resolved.
 *
 * A credential records a handle together with the org a verified flow
 * established; a handle this credential does not prove is not used as
 * identity, and the caller falls back to `fallback` (the DoltHub org
 * name). The stored string stays on the credential, so it is used again
 * as soon as a verified flow records the proof for that org.
 */
export function identityRigHandle(
  credential: WastelandCredentialResult | null,
  org: string | null,
  fallback: string
): string {
  if (credential === null || credential.rig_handle === null || org === null) return fallback;
  return credentialProvesOrg(credential, org) ? credential.rig_handle : fallback;
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
    proven_org: parsed.proven_org,
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
