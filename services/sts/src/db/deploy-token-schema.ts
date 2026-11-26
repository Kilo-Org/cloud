import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
 * One row per Cloudflare deploy-token creation STS started, never the token value or the minting
 * credential. A row counts against its workload's active limit while `pending` or `active` and
 * unexpired, and against the hourly limit by `created_at` whatever its state. The alarm deletes a
 * row a day after it ended, and a handed-over token's row only once the sweep compared the Worker
 * scripts changed while it was live with its `intended_scripts`.
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
    /** The policy's `intendedScripts` when the token was made (JSON array), for the script check. */
    intendedScripts: text('intended_scripts').notNull(),
    /** A handed-over token's live window was compared with the account's Worker scripts. */
    scriptsChecked: integer('scripts_checked', { mode: 'boolean' }).notNull().default(false),
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
