import { eq, and, lt } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { Ok, Err, type Result } from '../../lib/result.js';
import { calculateExpiry, isExpired } from '../../core/lease.js';
import { executionLeases } from '../../db/sqlite-schema.js';

type SqlStorage = DurableObjectState['storage']['sql'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeaseRecord = {
  executionId: string;
  leaseId: string;
  leaseExpiresAt: number;
  updatedAt: number;
  messageId: string | null;
};

export type LeaseAcquireError =
  | { code: 'ALREADY_HELD'; holder: string; expiresAt: number }
  | { code: 'SQL_ERROR'; message: string };

export type LeaseExtendError =
  | { code: 'NOT_FOUND' }
  | { code: 'WRONG_HOLDER'; currentHolder: string }
  | { code: 'SQL_ERROR'; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DbLeaseRow = typeof executionLeases.$inferSelect;

function toLeaseRecord(row: DbLeaseRow): LeaseRecord {
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

export function createLeaseQueries(db: DrizzleSqliteDODatabase, rawSql: SqlStorage) {
  return {
    /**
     * Try to acquire a lease atomically.
     *
     * SAFETY NOTE: The check-then-set pattern is safe because Durable Objects
     * serialize all incoming requests within a single instance.
     */
    tryAcquire(
      executionId: string,
      leaseId: string,
      messageId: string,
      now: number = Date.now()
    ): Result<{ acquired: true; expiresAt: number }, LeaseAcquireError> {
      const expiresAt = calculateExpiry(now);

      try {
        const existing = db
          .select({
            lease_id: executionLeases.lease_id,
            lease_expires_at: executionLeases.lease_expires_at,
          })
          .from(executionLeases)
          .where(eq(executionLeases.execution_id, executionId))
          .get();

        if (existing) {
          if (!isExpired(existing.lease_expires_at, now)) {
            return Err({
              code: 'ALREADY_HELD',
              holder: existing.lease_id,
              expiresAt: existing.lease_expires_at,
            });
          }

          // Expired - update to claim
          db.update(executionLeases)
            .set({
              lease_id: leaseId,
              lease_expires_at: expiresAt,
              updated_at: now,
              message_id: messageId,
            })
            .where(eq(executionLeases.execution_id, executionId))
            .run();
        } else {
          db.insert(executionLeases)
            .values({
              execution_id: executionId,
              lease_id: leaseId,
              lease_expires_at: expiresAt,
              updated_at: now,
              message_id: messageId,
            })
            .run();
        }

        return Ok({ acquired: true, expiresAt });
      } catch (e) {
        return Err({
          code: 'SQL_ERROR',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },

    extend(
      executionId: string,
      leaseId: string,
      now: number = Date.now()
    ): Result<{ expiresAt: number }, LeaseExtendError> {
      const expiresAt = calculateExpiry(now);

      const existing = db
        .select({ lease_id: executionLeases.lease_id })
        .from(executionLeases)
        .where(eq(executionLeases.execution_id, executionId))
        .get();

      if (!existing) {
        return Err({ code: 'NOT_FOUND' });
      }

      if (existing.lease_id !== leaseId) {
        return Err({
          code: 'WRONG_HOLDER',
          currentHolder: existing.lease_id,
        });
      }

      db.update(executionLeases)
        .set({
          lease_expires_at: expiresAt,
          updated_at: now,
        })
        .where(eq(executionLeases.execution_id, executionId))
        .run();

      return Ok({ expiresAt });
    },

    release(executionId: string, leaseId: string): boolean {
      const { sql: query, params } = db
        .delete(executionLeases)
        .where(
          and(eq(executionLeases.execution_id, executionId), eq(executionLeases.lease_id, leaseId))
        )
        .toSQL();
      return rawSql.exec(query, ...params).rowsWritten > 0;
    },

    get(executionId: string): LeaseRecord | null {
      const row = db
        .select()
        .from(executionLeases)
        .where(eq(executionLeases.execution_id, executionId))
        .get();

      if (!row) return null;
      return toLeaseRecord(row);
    },

    isHeld(executionId: string, now: number = Date.now()): boolean {
      const lease = this.get(executionId);
      if (!lease) return false;
      return !isExpired(lease.leaseExpiresAt, now);
    },

    findExpired(now: number = Date.now()): LeaseRecord[] {
      const rows = db
        .select()
        .from(executionLeases)
        .where(lt(executionLeases.lease_expires_at, now))
        .all();

      return rows.map(toLeaseRecord);
    },

    deleteExpired(now: number = Date.now()): number {
      const { sql: query, params } = db
        .delete(executionLeases)
        .where(lt(executionLeases.lease_expires_at, now))
        .toSQL();
      return rawSql.exec(query, ...params).rowsWritten;
    },
  };
}

export type LeaseQueries = ReturnType<typeof createLeaseQueries>;
