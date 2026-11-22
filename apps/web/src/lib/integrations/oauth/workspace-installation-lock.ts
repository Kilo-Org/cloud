import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { sql } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';

export async function withWorkspaceInstallationLock<T>(
  platform: 'linear' | 'slack' | 'discord',
  owner: Owner,
  installationId: string,
  operation: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    const ownerKey = `integration-installation-owner:${platform}:${owner.type}:${owner.id}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerKey}, 0))`);
    const key = `integration-installation:${platform}:${installationId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return operation(tx);
  });
}

/** How long a waiter waits for an installation lock before it aborts. */
export const INSTALLATION_LOCK_WAIT_MS = 5_000;

/**
 * Budget for the SQL a locked section may run. Together with the section's own
 * external-call budget it must stay below INSTALLATION_LOCK_WAIT_MS, so a waiter
 * never aborts because a section outweighed its wait.
 */
export const INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS = 2_000;

/**
 * Serialize operations on one installation id. This takes no owner key, so an
 * operation that only concerns a single installation never blocks another
 * installation of the same owner.
 *
 * The statement budget here does not bound an external call the section makes;
 * that call needs its own budget, and the two together must stay below the lock
 * wait.
 */
export async function withInstallationServerLock<T>(
  platform: 'linear' | 'slack' | 'discord',
  installationId: string,
  operation: (tx: DrizzleTransaction) => Promise<T>
): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${INSTALLATION_LOCK_WAIT_MS}ms'`));
    // Postgres rejects a placeholder in SET, so the value is rendered here.
    await tx.execute(
      sql.raw(`SET LOCAL statement_timeout = '${INSTALLATION_SERVER_LOCK_STATEMENT_TIMEOUT_MS}ms'`)
    );
    const key = `integration-installation:${platform}:${installationId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return operation(tx);
  });
}
