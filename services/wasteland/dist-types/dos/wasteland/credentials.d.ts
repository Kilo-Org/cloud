export type WastelandCredentialResult = {
    user_id: string;
    encrypted_token: string;
    dolthub_org: string;
    rig_handle: string | null;
    is_upstream_admin: boolean;
    connected_at: string;
};
export declare function initializeDatabase(sql: SqlStorage): void;
export declare function storeCredential(sql: SqlStorage, wastelandId: string, userId: string, input: {
    encryptedToken: string;
    dolthubOrg: string;
    rigHandle?: string;
    isUpstreamAdmin?: boolean;
}): WastelandCredentialResult;
export declare function getCredential(sql: SqlStorage, wastelandId: string, userId: string): WastelandCredentialResult | null;
/**
 * Update the `is_upstream_admin` flag for an existing credential.
 * Returns the updated row, or null if no credential exists.
 */
export declare function setIsUpstreamAdmin(sql: SqlStorage, wastelandId: string, userId: string, isUpstreamAdmin: boolean): WastelandCredentialResult | null;
export declare function deleteCredential(sql: SqlStorage, wastelandId: string, userId: string): void;
