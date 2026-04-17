import 'server-only';

import { attachDatabasePool } from '@vercel/functions';
import { computeDatabaseUrl } from '@kilocode/db';
import { createDrizzleClient } from '@kilocode/db/client';

export function getPersonalProvisionLockKey(userId: string): string {
  return `kiloclaw:provision:personal:${userId}`;
}

export function getOrganizationProvisionLockKey(userId: string, organizationId: string): string {
  return `kiloclaw:provision:org:${userId}:${organizationId}`;
}

const DEFAULT_PROVISION_LOCK_POOL_MAX = 16;

function getProvisionLockPoolMax(): number {
  const parsed = Number.parseInt(process.env.KILOCLAW_PROVISION_LOCK_POOL_MAX || '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PROVISION_LOCK_POOL_MAX;
  }
  return parsed;
}

const provisionLockClient = createDrizzleClient({
  connectionString: computeDatabaseUrl(),
  poolConfig: {
    max: getProvisionLockPoolMax(),
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: Number.parseInt(process.env.POSTGRES_CONNECT_TIMEOUT || '30000'),
    application_name: 'kilocode-web-kiloclaw-provision-lock',
  },
});

if (process.env.NODE_ENV !== 'test') {
  attachDatabasePool(provisionLockClient.pool);
}

provisionLockClient.pool.on('error', err => {
  console.error('Unexpected error on idle client (kiloclaw provision lock)', err);
});

export async function withKiloclawProvisionContextLock<T>(
  lockKey: string,
  work: () => Promise<T>
): Promise<T> {
  const client = await provisionLockClient.pool.connect();
  let lockAcquired = false;

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    lockAcquired = true;
    return await work();
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
      } catch (error) {
        console.error('[kiloclaw] Failed to release provision context lock', {
          lockKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    client.release();
  }
}
