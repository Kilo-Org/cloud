import type { LeaseGrant } from '@kilocode/sts-contracts';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { LeaseRevokeCause } from '../audit/events';

export { auditEvent, auditPrune, auditWatermark } from './audit-tables';

/**
 * `pending`: a creation holds its slot while the manager call runs; `active`: the lease was handed
 * to the caller; `revoked`: STS revoked it; `failed`: the creation gave nothing to the caller;
 * `unconfirmed`: STS stopped trying to revoke a delivered lease without Infisical confirming it,
 * and a person must end its sessions.
 */
export type LeaseState = 'pending' | 'active' | 'revoked' | 'failed' | 'unconfirmed';

/**
 * One row per lease creation STS started, never a username or password. A row counts against its
 * workload's active limit while `pending` or `active` and unexpired, and against the per-minute
 * limit by `created_at` whatever its state. The alarm deletes a row a day after it ended.
 */
export const lease = sqliteTable(
  'lease',
  {
    slot: integer('slot').primaryKey({ autoIncrement: true }),
    /** Infisical's lease id; null until the creation answered. */
    leaseId: text('lease_id').unique(),
    workload: text('workload').notNull(),
    /** The caller's audit fields (`LeaseAuditCaller` as JSON), for the rows the alarm writes. */
    caller: text('caller').notNull(),
    /** A GitHub caller's run id: only a job of the same run may revoke the lease. Null for a Worker. */
    runId: text('run_id'),
    grant: text('lease_grant').$type<LeaseGrant>().notNull(),
    state: text('state').$type<LeaseState>().notNull(),
    createdAt: integer('created_at').notNull(),
    /** `pending`: when the creation budget runs out; otherwise the lease's own expiry. */
    expiresAt: integer('expires_at').notNull(),
    /** When the row stopped counting: revoked, failed, or (unset) at `expiresAt`. */
    endedAt: integer('ended_at'),
    /**
     * Set while a revocation is owed and Infisical has not confirmed it: the alarm retries it until
     * Infisical does, for at most a day past the lease's expiry. The cause its `lease.revoked` rows
     * carry.
     */
    revokeCause: text('revoke_cause').$type<LeaseRevokeCause>(),
    /**
     * An owed revocation: the earliest time the alarm may try it again (the last attempt plus
     * `LEASE_REVOKE_RETRY_MS`, or Infisical's `Retry-After` when longer). The alarm takes the
     * earliest first, so a lease that keeps failing cannot hold back the others.
     */
    revokeRetryAt: integer('revoke_retry_at'),
    /**
     * The `revoke_failed` row of an owed revocation is written; later failures write none, and a
     * 404 from Infisical after it is `unconfirmed`, not `gone`.
     */
    revokeFailureAudited: integer('revoke_failure_audited', { mode: 'boolean' })
      .notNull()
      .default(false),
  },
  table => [index('lease_workload_created').on(table.workload, table.createdAt)]
);

/**
 * One row per replica the lease object sweeps (README "Replica sessions"), by Hyperdrive binding
 * name: when its next sweep is due and how many sweeps in a row failed. A replica no longer
 * configured loses its row at the next sweep.
 */
export const leaseReplicaSweep = sqliteTable('lease_replica_sweep', {
  replica: text('replica').primaryKey(),
  nextAt: integer('next_at').notNull(),
  failures: integer('failures').notNull().default(0),
});
