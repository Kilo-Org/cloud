import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  github_app_installations,
  github_install_states,
  kilocode_users,
  platform_integrations,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { beginGitHubAppInstall } from './install-start';

const ownerId = 'oauth/github-install-start-owner';

const caller = () => ({ user: { id: ownerId, is_admin: false } as User });

async function createOrgWithGitHub(values: Partial<typeof platform_integrations.$inferInsert>) {
  const organization = await createTestOrganization('Install start', ownerId, 0);
  await db.insert(platform_integrations).values({
    owned_by_organization_id: organization.id,
    platform: 'github',
    integration_type: 'app',
    platform_account_login: 'acme',
    repository_access: 'all',
    github_app_type: 'standard',
    ...values,
  });
  return { organization };
}

describe('GitHub install start gate', () => {
  beforeEach(async () => {
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = '';
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = '';
    await cleanupDbForTest();
    await db.insert(kilocode_users).values({
      id: ownerId,
      google_user_email: 'github-install-start@example.com',
      google_user_name: 'Install Start',
      google_user_image_url: '',
      stripe_customer_id: 'cus_install_start',
    });
  });

  afterEach(cleanupDbForTest);

  test('refuses to start an install while the only association is suspended', async () => {
    const { organization } = await createOrgWithGitHub({
      platform_installation_id: '778002',
      integration_status: 'suspended',
      suspended_at: new Date().toISOString(),
      github_connection_role: 'workflow',
    });

    await expect(
      beginGitHubAppInstall(caller(), { organizationId: organization.id, returnTo: null })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        "This organization's GitHub connection is suspended or needs attention. Restore or disconnect it before installing again.",
    });
    await expect(
      db
        .select()
        .from(github_install_states)
        .where(eq(github_install_states.owner_id, organization.id))
    ).resolves.toEqual([]);
  });

  test('refuses to start an install while a healthy association holds the slot', async () => {
    const { organization } = await createOrgWithGitHub({
      platform_installation_id: '778003',
      integration_status: 'active',
      github_connection_role: 'workflow',
    });

    await expect(
      beginGitHubAppInstall(caller(), { organizationId: organization.id, returnTo: null })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'This organization already has a GitHub installation. Disconnect it before installing another.',
    });
  });

  test('starts an install while the only association is locally disconnected', async () => {
    const { organization } = await createOrgWithGitHub({
      platform_installation_id: '778004',
      integration_status: 'suspended',
      suspended_at: new Date().toISOString(),
      suspended_by: 'local_disconnect',
      github_disconnected_at: new Date().toISOString(),
    });

    await expect(
      beginGitHubAppInstall(caller(), { organizationId: organization.id, returnTo: null })
    ).resolves.toEqual({ token: expect.any(String), appType: 'standard' });
    await expect(
      db
        .select()
        .from(github_install_states)
        .where(eq(github_install_states.owner_id, organization.id))
    ).resolves.toMatchObject([{ owner_type: 'org', owner_id: organization.id }]);
  });

  test('starts an install while the only association is a pending request', async () => {
    const { organization } = await createOrgWithGitHub({
      platform_installation_id: null,
      platform_account_id: '778005',
      integration_status: 'pending',
      metadata: { pending_approval: { status: 'awaiting_installation' } },
    });

    await expect(
      beginGitHubAppInstall(caller(), { organizationId: organization.id, returnTo: null })
    ).resolves.toEqual({ token: expect.any(String), appType: 'standard' });
  });

  test('refuses to start an install while a shared agent_only association holds the slot', async () => {
    // The connection-role check forbids an `agent_only` association without a
    // canonical installation, so the row is bound to one the way the shared
    // installation flow leaves it.
    const [canonical] = await db
      .insert(github_app_installations)
      .values({
        installation_id: '778006',
        github_app_type: 'standard',
        lifecycle_state: 'active',
      })
      .returning();
    const { organization } = await createOrgWithGitHub({
      platform_installation_id: '778006',
      integration_status: 'active',
      github_installation_id: canonical?.id ?? null,
      github_connection_role: 'agent_only',
    });

    await expect(
      beginGitHubAppInstall(caller(), { organizationId: organization.id, returnTo: null })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'This organization already has a GitHub installation. Disconnect it before installing another.',
    });
  });

  test('refuses to start an install while a deduplicated association holds the slot', async () => {
    // A migration-deduplication row is suspended and invisible to the workflow
    // connection predicate, but it still carries an installation id and was
    // never locally disconnected, so the completion gate counts it. The start
    // gate must refuse it for the same reason.
    const { organization } = await createOrgWithGitHub({
      platform_installation_id: '778007',
      integration_status: 'suspended',
      suspended_at: new Date().toISOString(),
      suspended_by: 'migration-0205-github-dedup',
    });

    await expect(
      beginGitHubAppInstall(caller(), { organizationId: organization.id, returnTo: null })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        "This organization's GitHub connection is suspended or needs attention. Restore or disconnect it before installing again.",
    });
  });

  test('starts an install for an organization approved for multiple installations', async () => {
    const { organization } = await createOrgWithGitHub({
      platform_installation_id: '778003',
      integration_status: 'active',
      github_connection_role: 'workflow',
    });
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = organization.id;

    await expect(
      beginGitHubAppInstall(caller(), { organizationId: organization.id, returnTo: null })
    ).resolves.toEqual({ token: expect.any(String), appType: 'standard' });
  });
});
