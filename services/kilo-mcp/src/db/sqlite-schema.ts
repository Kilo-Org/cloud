import { sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * DO SQLite schema for the KiloMcpOAuthStore Durable Object (s5, migration tag v1).
 *
 * All timestamps are ISO-8601 strings (UTC) so they compare correctly with
 * `>` / `<` in SQLite and clone cleanly over DO RPC.
 */

/** RFC 7591 dynamic client registrations (public clients only — no secret column). */
export const oauthClients = sqliteTable('oauth_clients', {
  client_id: text('client_id').primaryKey(),
  /** JSON-encoded string array of registered redirect URIs. */
  redirect_uris: text('redirect_uris').notNull(),
  client_name: text('client_name').notNull(),
  created_at: text('created_at').notNull(),
});

/**
 * Authorization codes, created as short-lived single-use pairing records by
 * GET /authorize (status 'pending') and filled with the Kilo identity when the
 * user approves the device-auth pairing (status 'approved'). The token
 * endpoint consumes a code atomically (approved -> 'used').
 */
export const oauthCodes = sqliteTable(
  'oauth_codes',
  {
    /** The authorization code itself: 256-bit random, single-use, TTL-bound. */
    code: text('code').primaryKey(),
    client_id: text('client_id').notNull(),
    redirect_uri: text('redirect_uri').notNull(),
    /** PKCE S256 challenge (the only method this server accepts). */
    code_challenge: text('code_challenge').notNull(),
    /** RFC 8707 resource indicator this code is bound to. */
    resource: text('resource').notNull(),
    scope: text('scope').notNull(),
    /** Opaque CSRF state echoed back to the client on redirect. */
    state: text('state'),
    /** The apps/web device-auth pairing code (`code` from POST /api/device-auth/codes). */
    device_auth_code: text('device_auth_code').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'used', 'denied'] }).notNull(),
    /** Set when the user approves the pairing; until then the code cannot be exchanged. */
    kilo_user_id: text('kilo_user_id'),
    /** Null for personal (org-less) identities. */
    organization_id: text('organization_id'),
    /**
     * The Kilo API token returned when the device-auth pairing was approved
     * (s6). Single-use upstream: it is persisted the moment the worker learns
     * of the approval so no second poll is ever needed. Never logged.
     */
    kilo_token: text('kilo_token'),
    created_at: text('created_at').notNull(),
    expires_at: text('expires_at').notNull(),
  },
  table => [uniqueIndex('uq_oauth_codes_device_auth_code').on(table.device_auth_code)]
);

/** Opaque refresh tokens, stored only as SHA-256 hashes; rotation revokes the old row. */
export const oauthRefreshTokens = sqliteTable(
  'oauth_refresh_tokens',
  {
    id: text('id').primaryKey(),
    /** Hex SHA-256 of the opaque refresh token handed to the client. */
    token_hash: text('token_hash').notNull(),
    client_id: text('client_id').notNull(),
    kilo_user_id: text('kilo_user_id').notNull(),
    organization_id: text('organization_id'),
    /**
     * The Kilo API token this grant was minted from (s6): the credential the
     * worker forwards to apps/web when the bearer presenting an MCP access
     * token calls a procedure. Copied forward across rotations. Never logged.
     */
    kilo_token: text('kilo_token'),
    resource: text('resource').notNull(),
    scope: text('scope').notNull(),
    created_at: text('created_at').notNull(),
    expires_at: text('expires_at').notNull(),
    revoked_at: text('revoked_at'),
  },
  table => [uniqueIndex('uq_oauth_refresh_tokens_hash').on(table.token_hash)]
);

/**
 * Registry of revoked access-token jtis. verify.ts rejects any token whose jti
 * appears here; rows are purged once the token's own expiry has passed (a
 * revoked-but-expired token is already useless).
 */
export const oauthRevokedJtis = sqliteTable('oauth_revoked_jtis', {
  jti: text('jti').primaryKey(),
  /** Expiry of the access token this jti belonged to (ISO string). */
  expires_at: text('expires_at').notNull(),
  revoked_at: text('revoked_at').notNull(),
});
