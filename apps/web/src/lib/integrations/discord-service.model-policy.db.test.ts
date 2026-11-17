/**
 * The model catalog snapshot is the documented seam that keeps a policy decision
 * independent of the live catalog (see `slack-bot/model-allow-list.test.ts`).
 * The policy rows, the organization and the installation below are real database
 * fixtures; only the providers-by-model snapshot is stubbed.
 */
jest.mock(
  '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server',
  () => ({
    ...jest.requireActual(
      '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server'
    ),
    getProviderSlugsForModel: jest.fn(async () => new Set(['test-provider'])),
  })
);

import { db } from '@kilocode/web-shared/lib/drizzle';
import { organization_group_policy_settings, platform_integrations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import type { Owner } from './core/types';
import { INTEGRATION_STATUS, PLATFORM } from './core/constants';
import { getModel } from './discord-service';

const ALLOWED_MODEL = 'test-org/allowed-model';
const OUTSIDE_MODEL = 'test-org/outside-model';

const createdOrganizationIds: string[] = [];
let createdUserId: string | null = null;

async function seedPolicy(orgId: string, allowList: string[]) {
  await db.insert(organization_group_policy_settings).values({
    organization_id: orgId,
    default_policies: [
      {
        type: 'model_access',
        data: { mode: 'selected', model_allow_list: allowList, provider_allow_list: [] },
      },
    ],
    policy_revision: 1,
  });
}

async function seedInstallation(owner: Owner, modelSlug: string) {
  await db.insert(platform_integrations).values({
    owned_by_user_id: owner.type === 'user' ? owner.id : null,
    owned_by_organization_id: owner.type === 'org' ? owner.id : null,
    platform: PLATFORM.DISCORD,
    integration_type: 'oauth',
    platform_installation_id: '123456789012345678',
    platform_account_id: '123456789012345678',
    platform_account_login: 'Policy Server',
    scopes: ['bot', 'guilds'],
    integration_status: INTEGRATION_STATUS.ACTIVE,
    metadata: { model_slug: modelSlug },
    installed_at: new Date().toISOString(),
  });
}

describe('Discord getModel organization policy resolution', () => {
  it('keeps a stored organization model the current policy still allows', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization('Discord Policy Allowed', owner.id, 0);
    createdOrganizationIds.push(organization.id);
    await seedPolicy(organization.id, [ALLOWED_MODEL]);
    const orgOwner: Owner = { type: 'org', id: organization.id };
    await seedInstallation(orgOwner, ALLOWED_MODEL);

    await expect(getModel(orgOwner)).resolves.toBe(ALLOWED_MODEL);
  });

  it('falls back to the allowed default when the policy no longer allows the stored model', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization('Discord Policy Narrowed', owner.id, 0);
    createdOrganizationIds.push(organization.id);
    await seedPolicy(organization.id, [ALLOWED_MODEL]);
    const orgOwner: Owner = { type: 'org', id: organization.id };
    await seedInstallation(orgOwner, OUTSIDE_MODEL);

    await expect(getModel(orgOwner)).resolves.toBe(DEFAULT_BOT_MODEL);
  });

  it('keeps the stored model of a user-owned installation', async () => {
    const owner = await insertTestUser();
    createdUserId = owner.id;
    const userOwner: Owner = { type: 'user', id: owner.id };
    await seedInstallation(userOwner, OUTSIDE_MODEL);

    await expect(getModel(userOwner)).resolves.toBe(OUTSIDE_MODEL);
  });

  afterAll(async () => {
    for (const orgId of createdOrganizationIds) {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, orgId));
      await db
        .delete(organization_group_policy_settings)
        .where(eq(organization_group_policy_settings.organization_id, orgId));
    }
    if (createdUserId) {
      await db
        .delete(platform_integrations)
        .where(eq(platform_integrations.owned_by_user_id, createdUserId));
    }
  });
});
