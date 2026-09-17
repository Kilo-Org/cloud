import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { github_app_installations, platform_integrations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import {
  GitHubInstallationAccessDeniedError,
  InstallationLookupService,
} from '../../../../../../services/git-token-service/src/installation-lookup-service';

const installationId = '880099';
const connectionString = () => {
  const url = new URL(process.env.POSTGRES_URL!);
  url.pathname = `${url.pathname}-${process.env.JEST_WORKER_ID}`;
  return url.toString();
};

describe('InstallationLookupService database authorization', () => {
  const workerDb = getWorkerDb(connectionString());
  afterEach(cleanupDbForTest);
  afterAll(async () => {
    await workerDb.$client.end();
  });

  const service = () =>
    new InstallationLookupService(
      {
        HYPERDRIVE: {
          connectionString: connectionString(),
        },
      },
      workerDb
    );

  it('accepts true legacy direct lookups but rejects an unbound shadow when canonical exists', async () => {
    const user = await insertTestUser();
    const [legacy] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        github_app_type: null,
        platform_account_login: 'acme',
        integration_status: 'active',
      })
      .returning();
    await expect(
      service().assertActiveAssociationForInstallation(installationId, 'standard')
    ).resolves.toBeUndefined();
    await expect(service().findActiveAssociationById(legacy.id)).resolves.toMatchObject({
      success: true,
      installationId,
      githubAppType: 'standard',
    });

    await db.insert(github_app_installations).values({
      github_app_type: 'standard',
      installation_id: installationId,
      lifecycle_state: 'active',
      sharing_mode: 'web_cloud_agent',
    });
    await expect(
      service().assertActiveAssociationForInstallation(installationId, 'standard')
    ).rejects.toBeInstanceOf(GitHubInstallationAccessDeniedError);
    await expect(service().findActiveAssociationById(legacy.id)).resolves.toEqual({
      success: false,
    });
  });

  it('allows shared managed lookup only for the exact active association', async () => {
    const user = await insertTestUser();
    const [canonical] = await db
      .insert(github_app_installations)
      .values({
        github_app_type: 'standard',
        installation_id: installationId,
        account_login: 'acme',
        lifecycle_state: 'active',
        sharing_mode: 'web_cloud_agent',
        repository_access: 'selected',
        repositories: [{ id: 1, name: 'repo', full_name: 'acme/repo', private: true }],
        permissions: { contents: 'write', pull_requests: 'write' },
      })
      .returning();
    const [association] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        platform_account_login: 'acme',
        github_app_type: 'standard',
        github_installation_id: canonical.id,
        integration_status: 'active',
      })
      .returning();
    await expect(
      service().findManagedInstallationForRepo({
        githubRepo: 'acme/repo',
        userId: user.id,
        expectedIntegrationId: association.id,
      })
    ).resolves.toMatchObject({ success: true, installationId });
    await expect(
      service().findManagedInstallationForRepo({ githubRepo: 'acme/repo', userId: user.id })
    ).resolves.toEqual({ success: false, reason: 'no_installation_found' });

    await db
      .update(platform_integrations)
      .set({ github_disconnected_at: new Date().toISOString() })
      .where(eq(platform_integrations.id, association.id));
    await expect(
      service().findManagedInstallationForRepo({
        githubRepo: 'acme/repo',
        userId: user.id,
        expectedIntegrationId: association.id,
      })
    ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
  });
});
