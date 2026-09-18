import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * DO SQLite schema for the KiloMcpOAuthStore Durable Object (s6, migration tag
 * v1). The library (`@cloudflare/workers-oauth-provider`) owns clients, codes,
 * refresh tokens, and revoked jtis in OAUTH_KV. Local state bridges consent,
 * records issued refresh-token hashes for the strict reuse policy, and holds
 * the admin authenticators and the OTP-gated protected requests (o2).
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

/** Issued hashes authenticate replays; public token parts alone never do. */
export const oauthRefreshTokenHistory = sqliteTable(
  'oauth_refresh_token_history',
  {
    token_hash: text('token_hash').primaryKey(),
    user_id: text('user_id').notNull(),
    grant_id: text('grant_id').notNull(),
    current: integer('current', { mode: 'boolean' }).notNull(),
    expires_at: text('expires_at').notNull(),
  },
  table => [index('idx_oauth_refresh_token_grant').on(table.user_id, table.grant_id)]
);

/**
 * One TOTP authenticator per admin (o2). The row is created on first
 * enrollment and its `secret` is immutable afterwards: a picker re-render must
 * never invalidate the secret the admin already scanned. `verified_at` stays
 * null until `confirmAuthenticator` proves possession with a current code;
 * `last_used_step` records the RFC 6238 step of the last accepted execution
 * code, which is what makes an accepted code single use.
 *
 * `failed_attempts` and `locked_until` are the account-wide wrong-code limiter:
 * a protected request's own `attempts` cap is reset by every new
 * `call_protected`, so the authenticator carries the count that a fresh request
 * cannot reset. `MAX_OTP_FAILURES` consecutive failures set `locked_until`, and
 * an accepted code clears both.
 *
 * `secret` is base32 and never logged; no code is ever stored.
 */
export const mcpAdminAuthenticators = sqliteTable('mcp_admin_authenticators', {
  /** The admin the authenticator belongs to (one authenticator each). */
  kilo_user_id: text('kilo_user_id').primaryKey(),
  /** Base32 shared secret; never logged, never echoed outside enrollment. */
  secret: text('secret').notNull(),
  /** Null until a current code proved possession; an unverified row is unusable. */
  verified_at: text('verified_at'),
  /** RFC 6238 step of the last accepted execution code (single use). */
  last_used_step: integer('last_used_step'),
  /** Wrong execution codes since the last accepted code or lockout expiry. */
  failed_attempts: integer('failed_attempts').notNull().default(0),
  /** ISO timestamp until which submissions are refused; null when unlocked. */
  locked_until: text('locked_until'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

/**
 * One guarded MCP call waiting on its owner's OTP (o2). Created by
 * `call_protected` with the reviewed payload and claimed exactly once by
 * `submit_otp`; `input_json` is the only copy of the payload and disappears with
 * the row. `session_id` binds the request to the grant that created it, so no
 * other session can submit its code. A request is pending for
 * PROTECTED_REQUEST_TTL_SECONDS, accepts at most MAX_OTP_ATTEMPTS submissions,
 * and goes to `invalidated` when they are used up.
 *
 * Never logged: a code, a payload, or an identity.
 */
export const mcpProtectedRequests = sqliteTable(
  'mcp_protected_requests',
  {
    /** `crypto.randomUUID()`; handed to the caller as `request_id`. */
    id: text('id').primaryKey(),
    /** The grant that created the request; only that session may submit its code. */
    session_id: text('session_id').notNull(),
    /** The admin who owns the request; the authenticator is keyed by it. */
    kilo_user_id: text('kilo_user_id').notNull(),
    client_id: text('client_id').notNull(),
    path: text('path').notNull(),
    kind: text('kind', { enum: ['admin', 'debug'] }).notNull(),
    /** The reviewed JSON payload; never logged, removed with the row. */
    input_json: text('input_json'),
    status: text('status', { enum: ['pending', 'used', 'invalidated'] }).notNull(),
    /** Wrong submissions so far; MAX_OTP_ATTEMPTS invalidates the row. */
    attempts: integer('attempts').notNull().default(0),
    created_at: text('created_at').notNull(),
    /** The request is actionable for PROTECTED_REQUEST_TTL_SECONDS after creation. */
    expires_at: text('expires_at').notNull(),
  },
  table => [
    index('idx_mcp_protected_requests_session').on(
      table.session_id,
      table.status,
      table.expires_at
    ),
    index('idx_mcp_protected_requests_owner').on(
      table.kilo_user_id,
      table.status,
      table.expires_at
    ),
  ]
);
