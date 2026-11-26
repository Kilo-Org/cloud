import type { LeaseGrant } from '@kilocode/sts-contracts';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export { auditEvent, auditPrune, auditWatermark } from './audit-tables';

/**
 * `pending`: a creation holds its slot while the manager call runs; `active`: the lease was handed
 * to the caller; `revoked`: STS revoked it; `failed`: the creation gave nothing to the caller.
 */
export type LeaseState = 'pending' | 'active' | 'revoked' | 'failed';

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
    grant: text('lease_grant').$type<LeaseGrant>().notNull(),
    state: text('state').$type<LeaseState>().notNull(),
    createdAt: integer('created_at').notNull(),
    /** `pending`: when the creation budget runs out; otherwise the lease's own expiry. */
    expiresAt: integer('expires_at').notNull(),
    /** When the row stopped counting: revoked, failed, or (unset) at `expiresAt`. */
    endedAt: integer('ended_at'),
  },
  table => [index('lease_workload_created').on(table.workload, table.createdAt)]
);
