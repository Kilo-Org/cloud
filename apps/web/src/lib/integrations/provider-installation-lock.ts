import { db, pool } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { and, eq, or } from 'drizzle-orm';

const LOCK_TIMEOUT_MS = 5_000;
const STATEMENT_TIMEOUT_MS = 10_000;

export async function withProviderInstallationLocks<T>(input: {
  platform: string;
  installationIds: Array<string | null | undefined>;
  callback: () => Promise<T>;
}): Promise<T> {
  const ids = [...new Set(input.installationIds.filter((id): id is string => Boolean(id)))].sort();
  const client = await pool.connect();
  const acquired: string[] = [];
  try {
    await client.query(`SET lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
    await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
    for (const id of ids) {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${input.platform}:${id}`]);
      acquired.push(id);
    }
    return await input.callback();
  } finally {
    let destroyClient = false;
    for (const id of acquired.reverse()) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${input.platform}:${id}`]);
      } catch {
        destroyClient = true;
        break;
      }
    }
    client.release(destroyClient);
  }
}

export async function cleanupProviderInstallationIfUnclaimed(input: {
  platform: string;
  installationId: string;
  cleanup: () => Promise<void>;
}): Promise<boolean> {
  return withProviderInstallationLocks({
    platform: input.platform,
    installationIds: [input.installationId],
    callback: async () => {
      const [claimed] = await db
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
    },
  });
}

export async function withProviderInstallationLock<T>(input: {
  platform: string;
  installationId: string;
  callback: () => Promise<T>;
}): Promise<T> {
  return withProviderInstallationLocks({
    platform: input.platform,
    installationIds: [input.installationId],
    callback: input.callback,
  });
}
