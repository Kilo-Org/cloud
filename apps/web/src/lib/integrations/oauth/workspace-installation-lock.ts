import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { sql } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';

export async function withWorkspaceInstallationLock<T>(
  platform: 'linear' | 'slack',
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
