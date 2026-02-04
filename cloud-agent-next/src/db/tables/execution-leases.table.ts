/**
 * Execution leases table schema for CloudAgentSession Durable Object.
 */

import { z } from 'zod';
import { getTableFromZodSchema } from '../../utils/table.js';

/**
 * Full execution lease record schema.
 * Use for full-row queries like get() and findExpired().
 */
export const ExecutionLeaseRecord = z.object({
  execution_id: z.string(),
  lease_id: z.string(),
  lease_expires_at: z.number(),
  updated_at: z.number(),
  message_id: z.string().nullable(),
});

export type ExecutionLeaseRecord = z.infer<typeof ExecutionLeaseRecord>;

/**
 * Partial schemas for queries returning fewer columns.
 */
export const LeaseIdAndExpiry = ExecutionLeaseRecord.pick({
  lease_id: true,
  lease_expires_at: true,
});
export type LeaseIdAndExpiry = z.infer<typeof LeaseIdAndExpiry>;

export const LeaseIdOnly = ExecutionLeaseRecord.pick({ lease_id: true });
export type LeaseIdOnly = z.infer<typeof LeaseIdOnly>;

/**
 * Table interpolator for type-safe SQL queries.
 *
 * @example
 * // Use execution_leases.columns.* for INSERT column lists (unqualified)
 * const { columns: cols } = execution_leases;
 * sql.exec(`INSERT INTO ${execution_leases} (${cols.execution_id}, ...) VALUES (?, ...)`, ...);
 *
 * // Use execution_leases.* for SELECT/WHERE/ORDER (qualified)
 * sql.exec(`SELECT ${execution_leases.lease_id} FROM ${execution_leases} WHERE ${execution_leases.execution_id} = ?`, ...);
 */
export const execution_leases = getTableFromZodSchema('execution_leases', ExecutionLeaseRecord);
