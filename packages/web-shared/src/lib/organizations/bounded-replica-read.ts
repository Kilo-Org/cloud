import { sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

/**
 * Longest an optional dashboard read may run on the replica. A slower scan is cancelled so the
 * card can degrade within seconds instead of holding a connection for the server-wide timeout.
 */
export const BOUNDED_READ_STATEMENT_TIMEOUT_MS = 10_000;

/** Longest a bounded read waits for a lock; these reads never need one, so a wait means contention. */
export const BOUNDED_READ_LOCK_TIMEOUT_MS = 2_000;

const BOUNDED_READ_ERROR_CODES = new Set([
  '57014', // query_canceled: statement_timeout
  '55P03', // lock_not_available: lock_timeout
  '40001', // serialization_failure: replica recovery conflict
]);

/**
 * Runs `read` on the read replica inside a transaction that bounds statement and lock time.
 * The bounds are `SET LOCAL` in the same transaction: Supavisor in transaction mode drops
 * session-level `SET`, so they would not reach the query.
 */
export async function withBoundedReplicaRead<T>(
  read: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  return await readDb.transaction(async tx => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${BOUNDED_READ_STATEMENT_TIMEOUT_MS}`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${BOUNDED_READ_LOCK_TIMEOUT_MS}`));
    return await read(tx);
  });
}

/** Whether `error` is the replica cancelling a read because of its time bounds or a recovery conflict. */
export function isBoundedReadError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      BOUNDED_READ_ERROR_CODES.has(current.code)
    ) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
