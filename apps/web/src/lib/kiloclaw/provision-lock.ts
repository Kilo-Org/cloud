import 'server-only';

import { sql } from 'drizzle-orm';
import { db } from '@/lib/drizzle';

export function getPersonalProvisionLockKey(userId: string): string {
  return `kiloclaw:provision:personal:${userId}`;
}

export function getOrganizationProvisionLockKey(userId: string, organizationId: string): string {
  return `kiloclaw:provision:org:${userId}:${organizationId}`;
}

export async function withKiloclawProvisionContextLock<T>(
  lockKey: string,
  work: () => Promise<T>
): Promise<T> {
  return await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
    return await work();
  });
}
