import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { sql } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';

/** How long a waiter waits for an installation lock before it aborts. */
export const INSTALLATION_LOCK_WAIT_MS = 5_000;

/**
 * Budget for one SQL statement a locked section may run. The release section
 * runs at most two lookups, so its worst case is
 * `2 statements x 1s + 2s removal = 4s < 5s wait`. A third statement in that
 * section needs this budget re-checked against the lock wait.
 */
export const INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS = 1_000;

export async function withWorkspaceInstallationLock<T>(
  platform: 'linear' | 'slack' | 'discord',
  owner: Owner,
  installationId: string,
  operation: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  return db.transaction(async tx => {
    // Postgres rejects a placeholder in SET, so the value is rendered here.
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`));
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    const ownerKey = `integration-installation-owner:${platform}:${owner.type}:${owner.id}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerKey}, 0))`);
    const key = `integration-installation:${platform}:${installationId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
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
      sql.raw(`SET LOCAL statement_timeout = '${INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS}ms'`)
    );
    return operation(tx);
  });
}
