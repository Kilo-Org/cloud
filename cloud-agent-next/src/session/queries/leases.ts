/**
 * Lease queries module for CloudAgentSession Durable Object.
 *
 * Provides type-safe SQL operations for execution lease management,
 * enabling idempotent queue message processing.
 */

import { Ok, Err, type Result } from '../../lib/result.js';
import { calculateExpiry, isExpired } from '../../core/lease.js';
import {
  execution_leases,
  ExecutionLeaseRecord,
  LeaseIdAndExpiry,
  LeaseIdOnly,
  type ExecutionLeaseRecordType,
} from '../../db/tables/index.js';

type SqlStorage = DurableObjectState['storage']['sql'];

// Destructure for convenient access to columns
const { columns: cols } = execution_leases;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lease record from database (camelCase for API) */
export type LeaseRecord = {
  executionId: string;
  leaseId: string;
  leaseExpiresAt: number;
  updatedAt: number;
  messageId: string | null;
};

/** Error types for lease acquisition operations */
export type LeaseAcquireError =
  | { code: 'ALREADY_HELD'; holder: string; expiresAt: number }
  | { code: 'SQL_ERROR'; message: string };

/** Error types for lease extension operations */
export type LeaseExtendError =
  | { code: 'NOT_FOUND' }
  | { code: 'WRONG_HOLDER'; currentHolder: string }
  | { code: 'SQL_ERROR'; message: string };

// ---------------------------------------------------------------------------
// Helper: Convert DB row to LeaseRecord
// ---------------------------------------------------------------------------

function toLeaseRecord(row: ExecutionLeaseRecordType): LeaseRecord {
  return {
    executionId: row.execution_id,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
    updatedAt: row.updated_at,
    messageId: row.message_id,
  };
}

// ---------------------------------------------------------------------------
// Factory Function
// ---------------------------------------------------------------------------

/**
 * Create lease queries for the CloudAgentSession Durable Object.
 *
 * @param sql - SqlStorage instance from the DO context
 * @returns Object with lease query methods
 */
export function createLeaseQueries(sql: SqlStorage) {
  return {
    /**
     * Try to acquire a lease atomically.
     * Returns Ok if acquired, Err if already held by another lease.
     *
     * SAFETY NOTE: The check-then-set pattern used here (SELECT then UPDATE/INSERT)
     * is safe because Durable Objects serialize all incoming requests within a
     * single instance. There is no concurrent execution of RPC methods within a DO,
     * so no TOCTOU race condition can occur. An atomic UPDATE ... WHERE ... RETURNING
     * pattern would be equivalent but is not required for correctness here.
     *
     * @param executionId - ID of the execution to acquire lease for
     * @param leaseId - Unique ID for this lease attempt
     * @param messageId - Queue message ID for tracking
     * @param now - Current timestamp (defaults to Date.now())
     * @returns Result indicating success or reason for failure
     */
    tryAcquire(
      executionId: string,
      leaseId: string,
      messageId: string,
      now: number = Date.now()
    ): Result<{ acquired: true; expiresAt: number }, LeaseAcquireError> {
      const expiresAt = calculateExpiry(now);

      try {
        // Check if lease exists and is not expired
        const existing = sql.exec(
          `SELECT ${execution_leases.lease_id}, ${execution_leases.lease_expires_at} FROM ${execution_leases} WHERE ${execution_leases.execution_id} = ?`,
          executionId
        );

        const existingRow = [...existing][0];

        if (existingRow) {
          // Lease exists - check if expired
          const parsed = LeaseIdAndExpiry.parse(existingRow);
          const existingExpiresAt = parsed.lease_expires_at;

          if (!isExpired(existingExpiresAt, now)) {
            // Still held by someone else
            return Err({
              code: 'ALREADY_HELD',
              holder: parsed.lease_id,
              expiresAt: existingExpiresAt,
            });
          }

          // Expired - update to claim
          sql.exec(
            `UPDATE ${execution_leases}
             SET ${cols.lease_id} = ?, ${cols.lease_expires_at} = ?, ${cols.updated_at} = ?, ${cols.message_id} = ?
             WHERE ${execution_leases.execution_id} = ?`,
            leaseId,
            expiresAt,
            now,
            messageId,
            executionId
          );
        } else {
          // No existing lease - insert new
          sql.exec(
            `INSERT INTO ${execution_leases} (${cols.execution_id}, ${cols.lease_id}, ${cols.lease_expires_at}, ${cols.updated_at}, ${cols.message_id})
             VALUES (?, ?, ?, ?, ?)`,
            executionId,
            leaseId,
            expiresAt,
            now,
            messageId
          );
        }

        return Ok({ acquired: true, expiresAt });
      } catch (e) {
        return Err({
          code: 'SQL_ERROR',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },

    /**
     * Extend an existing lease (heartbeat).
     *
     * @param executionId - ID of the execution to extend lease for
     * @param leaseId - Lease ID that must match the current holder
     * @param now - Current timestamp (defaults to Date.now())
     * @returns Result with new expiry time or error
     */
    extend(
      executionId: string,
      leaseId: string,
      now: number = Date.now()
    ): Result<{ expiresAt: number }, LeaseExtendError> {
      const expiresAt = calculateExpiry(now);

      // Verify we hold the lease before extending
      const existing = sql.exec(
        `SELECT ${execution_leases.lease_id} FROM ${execution_leases} WHERE ${execution_leases.execution_id} = ?`,
        executionId
      );

      const row = [...existing][0];

      if (!row) {
        return Err({ code: 'NOT_FOUND' });
      }

      const parsed = LeaseIdOnly.parse(row);
      if (parsed.lease_id !== leaseId) {
        return Err({
          code: 'WRONG_HOLDER',
          currentHolder: parsed.lease_id,
        });
      }

      sql.exec(
        `UPDATE ${execution_leases} SET ${cols.lease_expires_at} = ?, ${cols.updated_at} = ? WHERE ${execution_leases.execution_id} = ?`,
        expiresAt,
        now,
        executionId
      );

      return Ok({ expiresAt });
    },

    /**
     * Release a lease (on completion).
     *
     * @param executionId - ID of the execution to release lease for
     * @param leaseId - Lease ID that must match the current holder
     * @returns true if lease was released, false if not found or wrong holder
     */
    release(executionId: string, leaseId: string): boolean {
      const result = sql.exec(
        `DELETE FROM ${execution_leases} WHERE ${execution_leases.execution_id} = ? AND ${execution_leases.lease_id} = ?`,
        executionId,
        leaseId
      );
      return result.rowsWritten > 0;
    },

    /**
     * Get lease details for an execution.
     *
     * @param executionId - ID of the execution to get lease for
     * @returns Lease record or null if not found
     */
    get(executionId: string): LeaseRecord | null {
      const result = sql.exec(
        `SELECT ${execution_leases.execution_id}, ${execution_leases.lease_id}, ${execution_leases.lease_expires_at}, ${execution_leases.updated_at}, ${execution_leases.message_id} FROM ${execution_leases} WHERE ${execution_leases.execution_id} = ?`,
        executionId
      );

      const row = [...result][0];

      if (!row) return null;

      return toLeaseRecord(ExecutionLeaseRecord.parse(row));
    },

    /**
     * Check if a lease is currently held (not expired).
     *
     * @param executionId - ID of the execution to check
     * @param now - Current timestamp (defaults to Date.now())
     * @returns true if lease is held and not expired
     */
    isHeld(executionId: string, now: number = Date.now()): boolean {
      const lease = this.get(executionId);
      if (!lease) return false;
      return !isExpired(lease.leaseExpiresAt, now);
    },

    /**
     * Get all expired leases (for cleanup).
     *
     * @param now - Current timestamp (defaults to Date.now())
     * @returns Array of expired lease records
     */
    findExpired(now: number = Date.now()): LeaseRecord[] {
      const result = sql.exec(
        `SELECT ${execution_leases.execution_id}, ${execution_leases.lease_id}, ${execution_leases.lease_expires_at}, ${execution_leases.updated_at}, ${execution_leases.message_id} FROM ${execution_leases} WHERE ${execution_leases.lease_expires_at} < ?`,
        now
      );

      return [...result].map(row => toLeaseRecord(ExecutionLeaseRecord.parse(row)));
    },

    /**
     * Delete all expired leases.
     *
     * @param now - Current timestamp (defaults to Date.now())
     * @returns Number of leases deleted
     */
    deleteExpired(now: number = Date.now()): number {
      const result = sql.exec(
        `DELETE FROM ${execution_leases} WHERE ${execution_leases.lease_expires_at} < ?`,
        now
      );
      return result.rowsWritten;
    },
  };
}

// ---------------------------------------------------------------------------
// Type Export
// ---------------------------------------------------------------------------

/** Type of the lease queries object returned by createLeaseQueries */
export type LeaseQueries = ReturnType<typeof createLeaseQueries>;
