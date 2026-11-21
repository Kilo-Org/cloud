import { sql } from 'drizzle-orm';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { getReadDbTarget } from '@kilocode/web-shared/lib/drizzle';

/**
 * Longest an optional dashboard read may run on the replica. A slower scan is cancelled so the
 * card can degrade within seconds instead of holding a connection for the server-wide timeout.
 */
export const BOUNDED_READ_STATEMENT_TIMEOUT_MS = 10_000;

/** Longest a bounded read waits for a lock; these reads never need one, so a wait means contention. */
export const BOUNDED_READ_LOCK_TIMEOUT_MS = 2_000;

type BoundedReadQuery = 'members' | 'agent_interactions' | 'cloud_agent_sessions' | 'code_reviews';

export class BoundedReplicaReadError extends Error {
  constructor(
    readonly diagnostics: NonNullable<ReturnType<typeof classifyBoundedReadError>> & {
      query: BoundedReadQuery;
      replica: ReturnType<typeof getReadDbTarget>['name'];
      elapsedMs: number;
    }
  ) {
    super('Bounded replica read did not complete');
  }
}

/**
 * Runs `read` on the read replica inside a transaction that bounds statement and lock time.
 * The bounds are `SET LOCAL` in the same transaction: Supavisor in transaction mode drops
 * session-level `SET`, so they would not reach the query.
 */
export async function withBoundedReplicaRead<T>(
  query: BoundedReadQuery,
  read: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  const { db, name } = getReadDbTarget();
  const start = performance.now();
  try {
    return await db.transaction(async tx => {
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = ${BOUNDED_READ_STATEMENT_TIMEOUT_MS}`)
      );
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${BOUNDED_READ_LOCK_TIMEOUT_MS}`));
      return await read(tx);
    });
  } catch (error) {
    const diagnostic = classifyBoundedReadError(error);
    if (!diagnostic) throw error;
    throw new BoundedReplicaReadError({
      ...diagnostic,
      query,
      replica: name,
      elapsedMs: Math.round(performance.now() - start),
    });
  }
}

/** Only return allowlisted values; Drizzle's outer message can contain SQL and parameters. */
export function classifyBoundedReadError(error: unknown) {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current);
    if ('code' in current) {
      const sqlstate = current.code;
      const message =
        'message' in current && typeof current.message === 'string' ? current.message : '';
      switch (sqlstate) {
        case '57014':
          return {
            sqlstate,
            reason:
              message === 'canceling statement due to statement timeout'
                ? 'statement_timeout'
                : 'query_canceled',
          } as const;
        case '55P03':
          return {
            sqlstate,
            reason:
              message === 'canceling statement due to lock timeout'
                ? 'lock_timeout'
                : 'lock_not_available',
          } as const;
        case '40001':
          return {
            sqlstate,
            reason:
              message === 'canceling statement due to conflict with recovery'
                ? 'replica_recovery_conflict'
                : 'serialization_failure',
          } as const;
      }
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}
