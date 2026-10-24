import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import {
  organization_group_memberships,
  organization_groups,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  OrganizationGroupInputSchema,
  OrganizationGroupPoliciesSchema,
  OrganizationGroupPolicySchema,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import {
  listOrganizationGroupsForManager,
  normalizeOrganizationGroupPolicy,
} from './organization-groups';

describe('organization group policies', () => {
  it('validates the model access discriminated union strictly', () => {
    expect(
      OrganizationGroupPolicySchema.safeParse({
        type: 'model_access',
        data: { mode: 'selected', model_allow_list: [], provider_allow_list: [] },
      }).success
    ).toBe(true);
    expect(OrganizationGroupPolicySchema.safeParse({ type: 'unknown' }).success).toBe(false);
    expect(
      OrganizationGroupPolicySchema.safeParse({
        type: 'model_access',
        data: { mode: 'all', unknown: true },
      }).success
    ).toBe(false);
  });

  it('rejects duplicate policy discriminators', () => {
    expect(
      OrganizationGroupPoliciesSchema.safeParse([
        { type: 'model_access', data: { mode: 'all' } },
        { type: 'model_access', data: { mode: 'none' } },
      ]).success
    ).toBe(false);
  });

  it('validates group metadata limits', () => {
    expect(
      OrganizationGroupInputSchema.safeParse({ name: ' Engineering ', policies: [] }).success
    ).toBe(true);
    expect(OrganizationGroupInputSchema.safeParse({ name: ' ', policies: [] }).success).toBe(false);
    expect(
      OrganizationGroupInputSchema.safeParse({ name: 'a'.repeat(81), policies: [] }).success
    ).toBe(false);
    expect(
      OrganizationGroupInputSchema.safeParse({
        name: 'Engineering',
        description: 'a'.repeat(501),
        policies: [],
      }).success
    ).toBe(false);
  });

  it('normalizes and deduplicates selected model and provider values', () => {
    expect(
      normalizeOrganizationGroupPolicy({
        type: 'model_access',
        data: {
          mode: 'selected',
          model_allow_list: ['openai/gpt-4o:free', 'openai/gpt-4o'],
          provider_allow_list: ['OpenAI/model', 'openai'],
        },
      })
    ).toEqual({
      type: 'model_access',
      data: {
        mode: 'selected',
        model_allow_list: ['openai/gpt-4o'],
        provider_allow_list: ['openai'],
      },
    });
  });
});

describe('organization group manager listing', () => {
  const createdOrganizationIds: string[] = [];

  afterEach(async () => {
    for (const organizationId of createdOrganizationIds.toReversed()) {
      await db.delete(organizations).where(eq(organizations.id, organizationId));
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId));
    }
    createdOrganizationIds.length = 0;
  });

  it('reports every group a member belongs to when memberships overlap', async () => {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Overlapping Groups Organization', plan: 'enterprise' })
      .returning();
    createdOrganizationIds.push(organization.id);

    const [firstUserId, secondUserId, thirdUserId] = [
      'group-listing-user-first',
      'group-listing-user-second',
      'group-listing-user-third',
    ];
    await db.insert(organization_memberships).values(
      [firstUserId, secondUserId, thirdUserId].map(kiloUserId => ({
        organization_id: organization.id,
        kilo_user_id: kiloUserId,
        role: 'member' as const,
      }))
    );

    const groupRows = await db
      .insert(organization_groups)
      .values([
        { organization_id: organization.id, name: 'Alpha' },
        { organization_id: organization.id, name: 'Beta' },
        { organization_id: organization.id, name: 'Gamma' },
        { organization_id: organization.id, name: 'Delta' },
      ])
      .returning();
    const groupIdByName = new Map(groupRows.map(group => [group.name, group.id]));
    const groupId = (name: string): string => {
      const id = groupIdByName.get(name);
      if (!id) throw new Error(`Missing seeded group ${name}`);
      return id;
    };

    await db.insert(organization_group_memberships).values([
      { organization_id: organization.id, group_id: groupId('Alpha'), kilo_user_id: firstUserId },
      { organization_id: organization.id, group_id: groupId('Alpha'), kilo_user_id: secondUserId },
      { organization_id: organization.id, group_id: groupId('Beta'), kilo_user_id: secondUserId },
      { organization_id: organization.id, group_id: groupId('Beta'), kilo_user_id: thirdUserId },
      { organization_id: organization.id, group_id: groupId('Gamma'), kilo_user_id: firstUserId },
      { organization_id: organization.id, group_id: groupId('Gamma'), kilo_user_id: secondUserId },
      { organization_id: organization.id, group_id: groupId('Gamma'), kilo_user_id: thirdUserId },
    ]);

    const groups = await listOrganizationGroupsForManager(organization.id);

    expect(
      groups.map(group => ({ name: group.name, memberIds: [...group.memberIds].sort() }))
    ).toEqual([
      { name: 'Alpha', memberIds: [firstUserId, secondUserId].sort() },
      { name: 'Beta', memberIds: [secondUserId, thirdUserId].sort() },
      { name: 'Delta', memberIds: [] },
      { name: 'Gamma', memberIds: [firstUserId, secondUserId, thirdUserId].sort() },
    ]);
  });
});
