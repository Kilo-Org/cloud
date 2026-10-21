import { afterEach, describe, expect, it } from '@jest/globals';
import { byok_api_keys, kilocode_users, organization_memberships, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { validateOrganizationAutoTarget } from '@kilocode/web-shared/lib/organizations/organization-auto-model';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const PROVIDER_ID = 'kimi-coding';
const MODEL_ID = 'kimi-coding/kimi-for-coding';

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

async function seedOrganization(settings: {
  provider_allow_list?: string[];
  model_deny_list?: string[];
}) {
  const owner = await insertTestUser();
  createdUserIds.push(owner.id);
  const organization = await createTestOrganization(
    'Auto Target Organization',
    owner.id,
    1_000_000,
    settings,
    false
  );
  createdOrganizationIds.push(organization.id);
  await db.insert(byok_api_keys).values({
    organization_id: organization.id,
    provider_id: PROVIDER_ID,
    encrypted_api_key: encryptApiKey('fixture-credential', BYOK_ENCRYPTION_KEY),
    created_by: owner.id,
  });
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organization.id))
    .limit(1);
  return row;
}

describe('Organization Auto target validation for organization provider models', () => {
  afterEach(async () => {
    for (const organizationId of createdOrganizationIds.splice(0)) {
      await db.delete(byok_api_keys).where(eq(byok_api_keys.organization_id, organizationId));
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    for (const userId of createdUserIds.splice(0)) {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  });

  it('accepts a model the organization model policy permits', async () => {
    const organization = await seedOrganization({
      provider_allow_list: ['openai'],
      model_deny_list: [],
    });

    await expect(validateOrganizationAutoTarget(organization, MODEL_ID)).resolves.toEqual({
      kind: 'ok',
      modelId: MODEL_ID,
    });
  });

  it('rejects a model the organization model policy denies', async () => {
    const organization = await seedOrganization({
      provider_allow_list: ['openai'],
      model_deny_list: [MODEL_ID],
    });

    const validation = await validateOrganizationAutoTarget(organization, MODEL_ID);

    expect(validation).toEqual({
      kind: 'error',
      message: expect.stringContaining('is not allowed by the organization'),
    });
  });
});
