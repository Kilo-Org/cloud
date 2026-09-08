import { cleanupDbForTest, db, pool } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  cleanupProviderInstallationIfUnclaimed,
  withProviderInstallationLocks,
} from './provider-installation-lock';
import { insertTestUser } from '@/tests/helpers/user.helper';

describe('cleanupProviderInstallationIfUnclaimed', () => {
  afterEach(cleanupDbForTest);

  it.each(['slack', 'linear'])(
    'preserves %s provider state when another owner has claimed the old installation',
    async platform => {
      const user = await insertTestUser();
      await db.insert(platform_integrations).values({
        owned_by_user_id: user.id,
        platform,
        integration_type: 'oauth',
        platform_installation_id: 'OLD',
        integration_status: 'active',
      });
      const cleanup = jest.fn(async () => undefined);

      await expect(
        cleanupProviderInstallationIfUnclaimed({
          platform,
          installationId: 'OLD',
          cleanup,
        })
      ).resolves.toBe(false);
      expect(cleanup).not.toHaveBeenCalled();

      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.platform_installation_id, 'OLD'));
      await expect(
        cleanupProviderInstallationIfUnclaimed({
          platform,
          installationId: 'OLD',
          cleanup,
        })
      ).resolves.toBe(true);
      expect(cleanup).toHaveBeenCalledTimes(1);
    }
  );

  it('bounds provider lock acquisition and releases the dedicated client', async () => {
    const client = await pool.connect();
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['slack:BLOCKED']);
    try {
      await expect(
        withProviderInstallationLocks({
          platform: 'slack',
          installationIds: ['BLOCKED'],
          callback: async () => undefined,
        })
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['slack:BLOCKED']);
      client.release();
    }
  }, 10_000);

  it('resets session settings after a callback failure before returning the client', async () => {
    await expect(
      withProviderInstallationLocks({
        platform: 'linear',
        installationIds: ['FAIL'],
        callback: async () => Promise.reject(new Error('callback failed')),
      })
    ).rejects.toThrow('callback failed');

    const client = await pool.connect();
    try {
      const lockTimeout = await client.query<{ lock_timeout: string }>('SHOW lock_timeout');
      const statementTimeout = await client.query<{ statement_timeout: string }>(
        'SHOW statement_timeout'
      );
      expect(lockTimeout.rows[0]?.lock_timeout).toBe('0');
      expect(statementTimeout.rows[0]?.statement_timeout).toBe('0');
    } finally {
      client.release();
    }
  });
});
