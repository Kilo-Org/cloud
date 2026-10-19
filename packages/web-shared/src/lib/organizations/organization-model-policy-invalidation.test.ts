import { beforeEach, describe, expect, it } from '@jest/globals';
import { organization_group_policy_settings, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { invalidateOrganizationModelPolicyCache } from '@kilocode/web-shared/lib/organizations/organization-model-policy-cache';
import {
  deleteOrganizationGroup,
  setDefaultOrganizationGroupPolicy,
} from '@kilocode/web-shared/lib/organizations/organization-groups';
import {
  addUserToOrganization,
  markOrganizationAsDeleted,
  updateOrganizationSettings,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

jest.mock('@kilocode/web-shared/lib/organizations/organization-model-policy-cache', () => ({
  invalidateOrganizationModelPolicyCache: jest.fn(async () => {}),
}));

const mockedInvalidate = jest.mocked(invalidateOrganizationModelPolicyCache);

async function createEnterpriseOrganization() {
  const owner = await insertTestUser({
    google_user_email: `policy-invalidation-${crypto.randomUUID()}@example.com`,
  });
  const organization = await createTestOrganization('Org', owner.id, 0);
  return { owner, organization };
}

describe('organization model policy cache invalidation', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    mockedInvalidate.mockReset();
    mockedInvalidate.mockResolvedValue(undefined);
  });

  it('invalidates after a group policy mutation commits', async () => {
    const { owner, organization } = await createEnterpriseOrganization();
    const committedPolicies: unknown[] = [];
    mockedInvalidate.mockImplementation(async () => {
      const [settings] = await db
        .select({ defaultPolicies: organization_group_policy_settings.default_policies })
        .from(organization_group_policy_settings)
        .where(eq(organization_group_policy_settings.organization_id, organization.id));
      committedPolicies.push(settings?.defaultPolicies);
    });

    await setDefaultOrganizationGroupPolicy({
      organizationId: organization.id,
      actor: { id: owner.id, email: owner.google_user_email, name: owner.google_user_name },
      policy: { type: 'model_access', data: { mode: 'none' } },
    });

    expect(mockedInvalidate).toHaveBeenCalledWith(organization.id);
    expect(committedPolicies).toEqual([[{ type: 'model_access', data: { mode: 'none' } }]]);
  });

  it('does not invalidate when a group policy mutation rolls back', async () => {
    const { owner, organization } = await createEnterpriseOrganization();

    await expect(
      deleteOrganizationGroup({
        organizationId: organization.id,
        groupId: crypto.randomUUID(),
        actor: { id: owner.id, email: owner.google_user_email, name: owner.google_user_name },
      })
    ).rejects.toThrow('Group not found');

    expect(mockedInvalidate).not.toHaveBeenCalled();
  });

  it('invalidates when a member is added, but not for an existing member', async () => {
    const { owner, organization } = await createEnterpriseOrganization();
    const member = await insertTestUser({
      google_user_email: `policy-invalidation-member-${crypto.randomUUID()}@example.com`,
    });

    await expect(addUserToOrganization(organization.id, member.id, 'member')).resolves.toBe(true);
    expect(mockedInvalidate).toHaveBeenCalledWith(organization.id);

    mockedInvalidate.mockClear();
    await expect(addUserToOrganization(organization.id, owner.id, 'member')).resolves.toBe(false);
    expect(mockedInvalidate).not.toHaveBeenCalled();
  });

  it('leaves invalidation to the caller when it supplies the transaction', async () => {
    const { organization } = await createEnterpriseOrganization();
    const member = await insertTestUser({
      google_user_email: `policy-invalidation-member-${crypto.randomUUID()}@example.com`,
    });

    await db.transaction(async tx => {
      await addUserToOrganization(organization.id, member.id, 'member', tx);
      await markOrganizationAsDeleted(organization.id, tx);
    });

    expect(mockedInvalidate).not.toHaveBeenCalled();
  });

  it('invalidates after an organization is deleted', async () => {
    const { organization } = await createEnterpriseOrganization();

    await markOrganizationAsDeleted(organization.id);

    expect(mockedInvalidate).toHaveBeenCalledWith(organization.id);
  });

  it('invalidates after organization settings are replaced', async () => {
    const { organization } = await createEnterpriseOrganization();
    let committedDataCollection: unknown;
    mockedInvalidate.mockImplementation(async () => {
      const [row] = await db
        .select({ settings: organizations.settings })
        .from(organizations)
        .where(eq(organizations.id, organization.id));
      committedDataCollection = row?.settings.data_collection;
    });

    await updateOrganizationSettings(organization.id, { data_collection: 'deny' });

    expect(mockedInvalidate).toHaveBeenCalledWith(organization.id);
    expect(committedDataCollection).toBe('deny');
  });
});
