import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DeployTokenDeleteCause } from '../audit/events';

export { auditEvent, auditPrune, auditWatermark } from './audit-tables';

/**
 * `pending`: a creation holds its slot while the Cloudflare call runs; `active`: the token was
 * handed to the caller; `deleted`: Cloudflare deleted it (or no longer had it); `failed`: the
 * creation gave nothing to the caller (a token it made anyway is deleted while `delete_cause` is
 * set).
 */
export type DeployTokenState = 'pending' | 'active' | 'deleted' | 'failed';

/**
 * The window check of a handed-over token: `checked` (the scripts and routes changed while it was
 * live were compared with the intended scripts) or `failed` (it gave up after its attempts and
 * wrote `deploy_token.script_check_failed`). Null while the check is owed.
 */
export type DeployTokenWindowCheck = 'checked' | 'failed';

/**
 * One row per Cloudflare deploy-token creation STS started, never the token value or the minting
 * credential. A row counts against its workload's active limit while `pending` or `active` and
 * unexpired, and against the hourly limit by `created_at` whatever its state. The alarm deletes a
 * row a day after it ended, and a handed-over token's row only once its window check ended.
 */
export const deployToken = sqliteTable(
  'deploy_token',
  {
    slot: integer('slot').primaryKey({ autoIncrement: true }),
    /** Cloudflare's token id; null until the creation answered with one. */
    tokenId: text('token_id').unique(),
    workload: text('workload').notNull(),
    /** The caller's audit fields (`DeployTokenAuditCaller` as JSON), for the rows the alarm writes. */
    caller: text('caller').notNull(),
    /** The GitHub run that asked: only a job of the same run may revoke the token. */
    runId: text('run_id').notNull(),
    permissionSet: text('permission_set').notNull(),
    state: text('state').$type<DeployTokenState>().notNull(),
    createdAt: integer('created_at').notNull(),
    /** `pending`: when the creation budget runs out; otherwise the token's own expiry. */
    expiresAt: integer('expires_at').notNull(),
    /** When Cloudflare deleted the token, or when a creation that made none failed. */
    endedAt: integer('ended_at'),
    /**
     * A failed creation whose outcome is unknown (the answer was lost, or an instance stopped
     * during the call): Cloudflare may hold a token STS never saw, so it counts against the
     * account share until such a token has expired and been swept. A creation Cloudflare refused,
     * or one never sent, made no token and does not count.
     */
    outcomeUnknown: integer('outcome_unknown', { mode: 'boolean' }).notNull().default(false),
    /** Set while a deletion is owed: the alarm retries it until Cloudflare takes it. */
    deleteCause: text('delete_cause').$type<DeployTokenDeleteCause>(),
    /** An owed deletion: the earliest time the alarm may try it again. */
    deleteRetryAt: integer('delete_retry_at'),
    /** Failed deletion attempts so far; each doubles the wait before the next. */
    deleteAttempts: integer('delete_attempts').notNull().default(0),
    /** The `delete_failed` row of an owed deletion is written; later failures write none. */
    deleteFailureAudited: integer('delete_failure_audited', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** The policy's `intendedScripts` when the token was made (JSON array), for the window check. */
    intendedScripts: text('intended_scripts').notNull(),
    /** The policy's `intendedRoutes` when the token was made (JSON array), for the window check. */
    intendedRoutes: text('intended_routes').notNull(),
    /** The policy's zones when the token was made (JSON array): the routes the token could write. */
    zones: text('zones').notNull(),
    windowCheck: text('window_check').$type<DeployTokenWindowCheck>(),
    /** Failed window checks so far; each doubles the wait before the next. */
    windowCheckAttempts: integer('window_check_attempts').notNull().default(0),
    /** A failed window check: the earliest time the alarm may try it again. */
    windowCheckRetryAt: integer('window_check_retry_at'),
  },
  table => [index('deploy_token_workload_created').on(table.workload, table.createdAt)]
);

/**
 * The sweep of the account's token list (one row, id 1): when the next one starts, and the page a
 * running one reads next (null when none runs).
 */
export const deployTokenSweep = sqliteTable('deploy_token_sweep', {
  id: integer('id').primaryKey(),
  nextSweepAt: integer('next_sweep_at').notNull(),
  page: integer('page'),
});

/**
 * A token the sweep found and could not delete, tried again by id from `retry_at` on, outside the
 * sweep: `attempts` failures of its own double the wait up to the sweep's daily interval (a 401 or
 * a 429 adds none, its hold or wait applies instead). Its `delete_failed` row is written once
 * (`failure_audited`). The row goes once Cloudflare deleted the token or no longer has it.
 */
export const deployTokenSweepRetry = sqliteTable('deploy_token_sweep_retry', {
  tokenId: text('token_id').primaryKey(),
  tokenName: text('token_name').notNull(),
  expiresAt: integer('expires_at'),
  retryAt: integer('retry_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  failureAudited: integer('failure_audited', { mode: 'boolean' }).notNull().default(false),
});

/**
 * Set after Cloudflare refused the minting credential (one row, id 1): the alarm makes no
 * Cloudflare call before `until`, and `hold_ms` is the hold the next refusal doubles. No row: no
 * hold.
 */
export const deployTokenCredentialHold = sqliteTable('deploy_token_credential_hold', {
  id: integer('id').primaryKey(),
  until: integer('until').notNull(),
  holdMs: integer('hold_ms').notNull(),
});

/**
 * The zones whose Workers routes the window check listed, and when it last did. A zone without a
 * row was never listed: its first check has no earlier list to compare with.
 */
export const deployTokenRouteZone = sqliteTable('deploy_token_route_zone', {
  zone: text('zone').primaryKey(),
  listedAt: integer('listed_at').notNull(),
});

/** Each zone's Workers routes as the window check last listed them. */
export const deployTokenRoute = sqliteTable(
  'deploy_token_route',
  {
    zone: text('zone').notNull(),
    routeId: text('route_id').notNull(),
    pattern: text('pattern').notNull(),
    script: text('script'),
  },
  table => [primaryKey({ columns: [table.zone, table.routeId] })]
);
