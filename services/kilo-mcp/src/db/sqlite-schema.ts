import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * DO SQLite schema for the KiloMcpOAuthStore Durable Object (s6, migration tag
 * v1). The library (`@cloudflare/workers-oauth-provider`) owns clients, codes,
 * refresh tokens, and revoked jtis in OAUTH_KV; the only hand-rolled state here
 * is the pending-authorization records (s2).
 *
 * All timestamps are ISO-8601 strings (UTC) so they compare correctly with
 * `>` / `<` in SQLite and clone cleanly over DO RPC.
 */

/**
 * Short-lived pending-authorization records for the library-owned OAuth flow
 * (`@cloudflare/workers-oauth-provider`). Created by GET /authorize and read by
 * /authorize/status and /authorize/org while the apps/web device-auth pairing
 * is in flight; the library AuthRequest JSON is the whole authorize request.
 * This is the only hand-rolled state the library does not own (s2).
 */
export const oauthPendingAuthorizations = sqliteTable(
  'oauth_pending_authorizations',
  {
    /** Internal random id (never the device-auth code, which stays queryable). */
    id: text('id').primaryKey(),
    /** JSON of the library AuthRequest (parsed authorize request). */
    auth_request: text('auth_request').notNull(),
    /** The apps/web device-auth pairing code (`code` from POST /api/device-auth/codes). */
    device_auth_code: text('device_auth_code').notNull(),
    status: text('status', {
      enum: ['pending', 'approved', 'denied', 'expired', 'completed'],
    }).notNull(),
    /** Set by recordPairingApproval (first-writer-wins); the library identity. */
    kilo_user_id: text('kilo_user_id'),
    /** Null for personal (org-less) identities; chosen at /authorize/org. */
    organization_id: text('organization_id'),
    /** Kilo API token from the approved pairing (s6); never logged. */
    kilo_token: text('kilo_token'),
    created_at: text('created_at').notNull(),
    expires_at: text('expires_at').notNull(),
  },
  table => [
    uniqueIndex('uq_oauth_pending_authorizations_device_auth_code').on(table.device_auth_code),
  ]
);
