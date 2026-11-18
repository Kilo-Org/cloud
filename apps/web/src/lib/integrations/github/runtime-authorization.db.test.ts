import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  github_app_installations,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  assertGitHubInstallationRuntimeAuthorized,
  GitHubRuntimeAuthorizationError,
} from './runtime-authorization';

const installationId = '880321';

describe('GitHub installation runtime authorization', () => {
  afterEach(cleanupDbForTest);

  async function seedPersonalWorkflowAssociation(ownerUserId: string) {
    const [installation] = await db
      .insert(github_app_installations)
      .values({
        github_app_type: 'standard',
        installation_id: installationId,
        account_login: 'acme',
        lifecycle_state: 'active',
        sharing_mode: 'exclusive',
        repository_access: 'selected',
        repositories: [{ id: 1, name: 'repo', full_name: 'acme/repo', private: true }],
        permissions: { contents: 'write', pull_requests: 'write' },
      })
      .returning();
    await db.insert(platform_integrations).values({
      owned_by_user_id: ownerUserId,
      platform: 'github',
      integration_type: 'app',
      platform_installation_id: installationId,
      platform_account_login: 'acme',
      github_app_type: 'standard',
      github_installation_id: installation.id,
      github_connection_role: 'workflow',
      integration_status: 'active',
    });
  }

  it('admits an association whose personal owner account is available', async () => {
    const owner = await insertTestUser();
    await seedPersonalWorkflowAssociation(owner.id);

    await expect(
      assertGitHubInstallationRuntimeAuthorized(installationId, 'standard')
    ).resolves.toBeUndefined();
  });

  it('refuses an association whose personal owner account is unavailable', async () => {
    const owner = await insertTestUser();
    await seedPersonalWorkflowAssociation(owner.id);
    await db
      .update(kilocode_users)
      .set({ blocked_at: new Date().toISOString() })
      .where(eq(kilocode_users.id, owner.id));

    await expect(
      assertGitHubInstallationRuntimeAuthorized(installationId, 'standard')
    ).rejects.toMatchObject({ reason: 'blocked_personal_owner' });
    await expect(
      assertGitHubInstallationRuntimeAuthorized(installationId, 'standard')
    ).rejects.toBeInstanceOf(GitHubRuntimeAuthorizationError);
  });
});
