import { cleanupDbForTest, db } from '@/lib/drizzle';
import { platform_integrations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { cleanupProviderInstallationIfUnclaimed } from './provider-installation-lock';
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
});
