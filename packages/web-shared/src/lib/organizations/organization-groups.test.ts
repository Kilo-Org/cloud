import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import {
  organization_audit_logs,
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
  deleteOrganizationGroup,
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

describe('organization group deletion with an input guardrail', () => {
  const createdOrganizationIds: string[] = [];
  const actor = { id: 'group-deletion-admin', email: 'admin@example.com', name: 'Admin' };

  afterEach(async () => {
    for (const organizationId of createdOrganizationIds) {
      await db.delete(organizations).where(eq(organizations.id, organizationId));
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
    }
    createdOrganizationIds.length = 0;
  });

  async function createOrganizationWithGroups(
    settings: (groupIds: { limited: string; other: string }) => OrganizationSettings
  ) {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Guardrail Group Organization', plan: 'enterprise' })
      .returning();
    createdOrganizationIds.push(organization.id);
    const [limited, other] = await db
      .insert(organization_groups)
      .values([
        { organization_id: organization.id, name: 'Limited' },
        { organization_id: organization.id, name: 'Other' },
      ])
      .returning();
    const groupIds = { limited: limited.id, other: other.id };
    await db
      .update(organizations)
      .set({ settings: settings(groupIds) })
      .where(eq(organizations.id, organization.id));
    return { organizationId: organization.id, groupIds };
  }

  async function readSettings(organizationId: string) {
    const [organization] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    return organization.settings;
  }

  async function groupExists(groupId: string) {
    const rows = await db
      .select({ id: organization_groups.id })
      .from(organization_groups)
      .where(eq(organization_groups.id, groupId));
    return rows.length > 0;
  }

  it.each<{ name: string; inputGuardrail: (groupId: string) => OrganizationSettings }>([
    {
      name: 'legacy detectors because none were saved',
      inputGuardrail: groupId => ({
        kilo_encrypt: true,
        enkrypt: { input_guardrail: { enabled: true, group_id: groupId } },
      }),
    },
    {
      name: 'invalid saved detectors',
      inputGuardrail: groupId => ({
        kilo_encrypt: true,
        enkrypt: {
          input_guardrail: {
            enabled: true,
            group_id: groupId,
            detectors: { injection_attack: true },
          },
        },
      }),
    },
  ])(
    'refuses to delete the group an active input guardrail with $name is limited to',
    async ({ inputGuardrail }) => {
      const { organizationId, groupIds } = await createOrganizationWithGroups(({ limited }) =>
        inputGuardrail(limited)
      );
      const settingsBefore = await readSettings(organizationId);

      const deletion = deleteOrganizationGroup({
        organizationId,
        groupId: groupIds.limited,
        actor,
      });

      await expect(deletion).rejects.toBeInstanceOf(TRPCError);
      await expect(deletion).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await groupExists(groupIds.limited)).toBe(true);
      expect(await readSettings(organizationId)).toEqual(settingsBefore);
    }
  );

  it.each<{ name: string; settings: (groupId: string) => OrganizationSettings }>([
    {
      name: 'is disabled',
      settings: groupId => ({
        kilo_encrypt: true,
        data_collection: 'deny',
        enkrypt: {
          input_guardrail: { enabled: false, scan_tool_results: true, group_id: groupId },
        },
      }),
    },
    {
      name: 'is not granted kilo_encrypt',
      settings: groupId => ({
        data_collection: 'deny',
        enkrypt: {
          input_guardrail: { enabled: true, scan_tool_results: true, group_id: groupId },
        },
      }),
    },
  ])('deletes the group and clears it from an input guardrail that $name', async ({ settings }) => {
    const { organizationId, groupIds } = await createOrganizationWithGroups(({ limited }) =>
      settings(limited)
    );

    await deleteOrganizationGroup({ organizationId, groupId: groupIds.limited, actor });

    expect(await groupExists(groupIds.limited)).toBe(false);
    const before = settings(groupIds.limited);
    expect(await readSettings(organizationId)).toEqual({
      ...before,
      enkrypt: {
        ...before.enkrypt,
        input_guardrail: { ...before.enkrypt?.input_guardrail, group_id: null },
      },
    });
  });

  it('deletes another group without changing an active input guardrail', async () => {
    const { organizationId, groupIds } = await createOrganizationWithGroups(({ limited }) => ({
      kilo_encrypt: true,
      enkrypt: { input_guardrail: { enabled: true, group_id: limited } },
    }));
    const settingsBefore = await readSettings(organizationId);

    await deleteOrganizationGroup({ organizationId, groupId: groupIds.other, actor });

    expect(await groupExists(groupIds.other)).toBe(false);
    expect(await groupExists(groupIds.limited)).toBe(true);
    expect(await readSettings(organizationId)).toEqual(settingsBefore);
  });

  it('deletes a group when the input guardrail applies to every member', async () => {
    const { organizationId, groupIds } = await createOrganizationWithGroups(() => ({
      kilo_encrypt: true,
      enkrypt: { input_guardrail: { enabled: true } },
    }));

    await deleteOrganizationGroup({ organizationId, groupId: groupIds.limited, actor });

    expect(await groupExists(groupIds.limited)).toBe(false);
    expect(await readSettings(organizationId)).toEqual({
      kilo_encrypt: true,
      enkrypt: { input_guardrail: { enabled: true } },
    });
  });
});
