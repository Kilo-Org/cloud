import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { sql } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';

/** How long a waiter waits for an installation lock before it aborts. */
export const INSTALLATION_LOCK_WAIT_MS = 5_000;

/**
 * Budget for one SQL statement a locked section may run. A section that makes an
 * external call must keep its statements plus that call below the wait, so every
 * such section carries its own budget: the Discord release section runs at most
 * two lookups at this budget plus a 2s bot removal
 * (`2 statements x 1s + 2s removal = 4s < 5s wait`), and the Slack retirement
 * section runs one lookup plus a 3s settlement
 * (`1 statement x 1s + 3s settlement = 4s < 5s wait`). A statement added to
 * either section needs this budget re-checked against the lock wait.
 */
export const INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS = 1_000;

/**
 * Default budget for one SQL statement of a section that takes both the owner
 * and the server lock. A section that makes an external call passes a lower
 * budget instead, so its statements and that call together stay below the lock
 * wait.
 */
export const INSTALLATION_WRITE_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Render a statement budget for a `SET` statement. Postgres rejects a
 * placeholder there, so the value is interpolated, and only a whole positive
 * millisecond count can be rendered.
 */
function renderStatementBudget(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new RangeError('A statement budget must be a whole number of milliseconds, at least 1');
  }
  return `'${ms}ms'`;
}

/**
 * Serialize a connection write on both its owner and its installation id. This
 * is the order the connect path takes the two keys in, so a write of the same
 * connection runs after the other finishes.
 *
 * The locks are taken before the statement budget is lowered, so a waiter
 * observes `lock_timeout` at the lock wait rather than at a statement budget.
 * The budget then applies to every statement of the section after the locks,
 * not to the section itself, so an external call the section makes needs its own
 * budget and the two together must stay below the lock wait. A budget that is
 * not a whole positive millisecond count is rejected before the section opens.
 */
export async function withWorkspaceInstallationLock<T>(
  platform: 'linear' | 'slack' | 'discord',
  owner: Owner,
  installationId: string,
  operation: (tx: DrizzleTransaction) => Promise<T>,
  {
    statementTimeoutMs = INSTALLATION_WRITE_STATEMENT_TIMEOUT_MS,
  }: { statementTimeoutMs?: number } = {}
): Promise<T> {
  // Rendered before the section opens, so an unusable budget never takes a lock.
  const statementBudget = renderStatementBudget(statementTimeoutMs);
  return db.transaction(async tx => {
    // Postgres rejects a placeholder in SET, so the value is rendered here.
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`));
    const ownerKey = `integration-installation-owner:${platform}:${owner.type}:${owner.id}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerKey}, 0))`);
    const key = `integration-installation:${platform}:${installationId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${statementBudget}`));
    return operation(tx);
  });
}

/**
 * Serialize operations on one installation id. This takes no owner key, so an
 * operation that only concerns a single installation never blocks another
 * installation of the same owner.
 *
 * The lock is taken before the statement budget is lowered, so the wait is the
 * lock wait rather than a statement budget. The statement budget then bounds
 * each statement of the section, not the section itself, so an external call the
 * section makes needs its own budget, and the two together must stay below the
 * lock wait.
 */
export async function withInstallationServerLock<T>(
  platform: 'linear' | 'slack' | 'discord',
  installationId: string,
  operation: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  return db.transaction(async tx => {
    const key = `integration-installation:${platform}:${installationId}`;
    // Postgres rejects a placeholder in SET, so the value is rendered here.
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`));
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    await tx.execute(
      sql.raw(
        `SET LOCAL statement_timeout = ${renderStatementBudget(INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS)}`
      )
    );
    return operation(tx);
  });
}
