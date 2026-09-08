import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, or, sql } from 'drizzle-orm';

export async function lockProviderInstallation(
  tx: DrizzleTransaction,
  platform: string,
  installationId: string
): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${platform}:${installationId}`}))`);
}

export async function lockProviderInstallations(
  tx: DrizzleTransaction,
  platform: string,
  installationIds: Array<string | null | undefined>
): Promise<void> {
  const ids = [...new Set(installationIds.filter((id): id is string => Boolean(id)))].sort();
  for (const installationId of ids) {
    await lockProviderInstallation(tx, platform, installationId);
  }
}

export async function cleanupProviderInstallationIfUnclaimed(input: {
  platform: string;
  installationId: string;
  cleanup: () => Promise<void>;
}): Promise<boolean> {
  return db.transaction(async tx => {
    await lockProviderInstallation(tx, input.platform, input.installationId);
    const [claimed] = await tx
      .select({ id: platform_integrations.id })
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, input.platform),
          or(
            eq(platform_integrations.platform_installation_id, input.installationId),
            eq(platform_integrations.platform_account_id, input.installationId)
          )
        )
      )
      .limit(1);
    if (claimed) return false;
    await input.cleanup();
    return true;
  });
}

export async function withProviderInstallationLock<T>(input: {
  platform: string;
  installationId: string;
  callback: () => Promise<T>;
}): Promise<T> {
  return db.transaction(async tx => {
    await lockProviderInstallation(tx, input.platform, input.installationId);
    return input.callback();
  });
}
