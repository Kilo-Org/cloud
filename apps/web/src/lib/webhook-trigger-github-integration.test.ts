import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { assertWebhookTriggerGitHubIntegrationAccess } from './webhook-trigger-github-integration';
import { kilocode_users, organizations, platform_integrations } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

describe('webhook trigger GitHub integration access', () => {
  const userId = `webhook-trigger-owner-${crypto.randomUUID()}`;
  let organizationId: string;
  let otherOrganizationId: string;

  beforeAll(async () => {
    await db.insert(kilocode_users).values({
      id: userId,
      google_user_email: `${userId}@example.com`,
      google_user_name: 'Webhook Trigger Owner',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_${crypto.randomUUID()}`,
    });
    const organizationsRows = await db
      .insert(organizations)
      .values([
        { name: `Webhook Trigger Org ${crypto.randomUUID()}` },
        { name: `Other Webhook Trigger Org ${crypto.randomUUID()}` },
      ])
      .returning({ id: organizations.id });
    if (!organizationsRows[0] || !organizationsRows[1]) {
      throw new Error('Failed to create webhook trigger test organizations');
    }
    organizationId = organizationsRows[0].id;
    otherOrganizationId = organizationsRows[1].id;
  });

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(
        inArray(platform_integrations.owned_by_organization_id, [
          organizationId,
          otherOrganizationId,
        ])
      );
  });

  afterAll(async () => {
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [organizationId, otherOrganizationId]));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [userId]));
  });

  async function insertIntegration(
    overrides: Partial<typeof platform_integrations.$inferInsert> = {}
  ) {
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organizationId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `installation-${crypto.randomUUID()}`,
        platform_account_login: 'acme',
        repository_access: 'selected',
        repositories: [{ id: 1, name: 'repository', full_name: 'acme/repository', private: true }],
        integration_status: 'active',
        ...overrides,
      })
      .returning({ id: platform_integrations.id });
    if (!integration) throw new Error('Failed to create webhook trigger test integration');
    return integration;
  }

  it('accepts the selected healthy integration for its repository', async () => {
    const integration = await insertIntegration();

    await expect(
      assertWebhookTriggerGitHubIntegrationAccess({
        organizationId,
        githubIntegrationId: integration.id,
        githubRepo: 'acme/repository',
      })
    ).resolves.toBeUndefined();
  });

  it.each([
    ['another owner', 'owner', 'acme/repository'],
    ['another repository', 'repository', 'acme/other'],
    ['an unhealthy integration', 'health', 'acme/repository'],
  ] as const)('rejects %s', async (_case, mismatch, githubRepo) => {
    const overrides =
      mismatch === 'owner'
        ? { owned_by_organization_id: otherOrganizationId }
        : mismatch === 'health'
          ? { integration_status: 'suspended' }
          : {};
    const integration = await insertIntegration(overrides);

    await expect(
      assertWebhookTriggerGitHubIntegrationAccess({
        organizationId,
        githubIntegrationId: integration.id,
        githubRepo,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
