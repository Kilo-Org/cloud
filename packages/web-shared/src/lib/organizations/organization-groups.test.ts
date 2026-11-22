import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import {
  ai_gateway_config,
  kilocode_users,
  organization_audit_logs,
  organization_group_memberships,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { AuditLogAction } from '@kilocode/web-shared/lib/organizations/audit-log-actions';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  OrganizationGroupInputSchema,
  OrganizationGroupModelAccessPolicyWriteSchema,
  OrganizationGroupPoliciesSchema,
  OrganizationGroupPolicySchema,
  type OrganizationGroupPolicy,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import { MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.schema';
import {
  deleteOrganizationGroup,
  listOrganizationGroupsForManager,
  normalizeOrganizationGroupPolicy,
  removeOrganizationGroupPolicy,
  setDefaultOrganizationGroupPolicy,
  setOrganizationGroupMembers,
  setOrganizationGroupPolicy,
  setOrganizationMemberGroups,
  updateOrganizationGroupDetails,
  updateOrganizationGroupMetadata,
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

  it('returns the value the write schema parsed for a selected model access policy', () => {
    const policy = {
      type: 'model_access' as const,
      data: {
        mode: 'selected' as const,
        model_allow_list: [' openai/gpt-4o '],
        provider_allow_list: [' openai '],
      },
    };

    expect(normalizeOrganizationGroupPolicy(policy)).toEqual(
      OrganizationGroupModelAccessPolicyWriteSchema.parse(policy)
    );
  });

  it('refuses a selected policy entry over the documented length', () => {
    let refused: unknown = undefined;
    try {
      normalizeOrganizationGroupPolicy({
        type: 'model_access',
        data: {
          mode: 'selected',
          model_allow_list: ['m'.repeat(MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH + 1)],
          provider_allow_list: [],
        },
      });
    } catch (error) {
      refused = error;
    }

    expect(refused).toBeInstanceOf(TRPCError);
    if (!(refused instanceof TRPCError)) throw new Error('Expected a TRPCError refusal');
    expect(refused.code).toBe('BAD_REQUEST');
    expect(refused.message).toBe(
      `A model id at index 0 ("${'m'.repeat(32)}…") must be at most ${MAX_ORGANIZATION_GROUP_MODEL_ID_LENGTH} characters long.`
    );
    expect(refused.cause).toBeInstanceOf(z.ZodError);
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

  async function settingsChangeMessages(organizationId: string) {
    const rows = await db
      .select({ action: organization_audit_logs.action, message: organization_audit_logs.message })
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organizationId));
    return rows
      .filter(row => row.action === 'organization.settings.change')
      .map(row => row.message);
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
      name: 'Kilo Default because no detectors were saved',
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
          input_guardrail: { enabled: false, group_id: groupId },
        },
      }),
    },
    {
      name: 'is not granted kilo_encrypt',
      settings: groupId => ({
        data_collection: 'deny',
        enkrypt: {
          input_guardrail: { enabled: true, group_id: groupId },
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
    expect(await settingsChangeMessages(organizationId)).toEqual([
      `Updated AI guardrails: input guardrails now apply to all members because group "Limited" (${groupIds.limited}) was deleted`,
    ]);
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
    expect(await settingsChangeMessages(organizationId)).toEqual([]);
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

describe('organization group audit messages', () => {
  const createdOrganizationIds: string[] = [];
  const createdUserIds: string[] = [];
  const actor = { id: 'group-audit-admin', email: 'admin@example.com', name: 'Admin' };

  afterEach(async () => {
    for (const organizationId of createdOrganizationIds) {
      // `organization_memberships` carries no foreign key, so deleting the
      // organization leaves its membership rows behind unless this deletes them.
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
    }
    for (const kiloUserId of createdUserIds) {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, kiloUserId));
    }
    createdOrganizationIds.length = 0;
    createdUserIds.length = 0;
  });

  async function createOrganization() {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Audit Message Organization', plan: 'enterprise' })
      .returning();
    createdOrganizationIds.push(organization.id);
    return organization;
  }

  async function createMember(organizationId: string) {
    const user = await insertTestUser();
    createdUserIds.push(user.id);
    await db
      .insert(organization_memberships)
      .values({ organization_id: organizationId, kilo_user_id: user.id, role: 'member' });
    return user;
  }

  async function auditMessages(organizationId: string, action: AuditLogAction) {
    // The `action` column rejects a plain `eq` against the zod-enum type under
    // tsgo, so this filter runs in JS like the harness above does.
    const rows = await db
      .select({
        action: organization_audit_logs.action,
        message: organization_audit_logs.message,
      })
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organizationId));
    return rows.filter(row => row.action === action).map(row => row.message);
  }

  it('singularizes the member count when updating group details for one member', async () => {
    const organization = await createOrganization();
    const [group] = await db
      .insert(organization_groups)
      .values({ organization_id: organization.id, name: 'One Member' })
      .returning();
    const user = await createMember(organization.id);

    await updateOrganizationGroupDetails({
      organizationId: organization.id,
      groupId: group.id,
      name: 'One Member Renamed',
      description: null,
      userIds: [user.id],
      actor,
    });

    const messages = await auditMessages(organization.id, 'organization.group.update');
    // The audit sentence names the group as it was before the rename.
    expect(messages).toEqual([`Updated group "One Member" (${group.id}) with 1 member`]);
    expect(messages.join(' ')).not.toContain('members');
  });

  it('uses the plural member count when updating group details for two members', async () => {
    const organization = await createOrganization();
    const [group] = await db
      .insert(organization_groups)
      .values({ organization_id: organization.id, name: 'Two Members' })
      .returning();
    const firstUser = await createMember(organization.id);
    const secondUser = await createMember(organization.id);

    await updateOrganizationGroupDetails({
      organizationId: organization.id,
      groupId: group.id,
      name: 'Two Members Renamed',
      description: null,
      userIds: [firstUser.id, secondUser.id],
      actor,
    });

    const messages = await auditMessages(organization.id, 'organization.group.update');
    expect(messages).toEqual([`Updated group "Two Members" (${group.id}) with 2 members`]);
  });

  it('singularizes the member count when setting group members to one member', async () => {
    const organization = await createOrganization();
    const [group] = await db
      .insert(organization_groups)
      .values({ organization_id: organization.id, name: 'Solo Group' })
      .returning();
    const user = await createMember(organization.id);

    await setOrganizationGroupMembers({
      organizationId: organization.id,
      groupId: group.id,
      userIds: [user.id],
      actor,
    });

    const messages = await auditMessages(organization.id, 'organization.group.members.set');
    expect(messages).toEqual([`Set 1 member for group "${group.name}" (${group.id})`]);
    expect(messages.join(' ')).not.toContain('members');
  });

  it('identifies the member by email when setting member groups', async () => {
    const organization = await createOrganization();
    const [group] = await db
      .insert(organization_groups)
      .values({ organization_id: organization.id, name: 'Email Identity Group' })
      .returning();
    const user = await createMember(organization.id);

    await setOrganizationMemberGroups({
      organizationId: organization.id,
      userId: user.id,
      groupIds: [group.id],
      actor,
    });

    const messages = await auditMessages(organization.id, 'organization.group.member_groups.set');
    expect(messages).toEqual([
      `Set 1 group for organization member ${user.google_user_email} (${user.id})`,
    ]);
    expect(messages[0]).toMatch(
      new RegExp(
        `^Set 1 group for organization member ${user.google_user_email.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&'
        )} \\(${user.id}\\)$`
      )
    );
  });
});

describe('organization group policy revision', () => {
  const createdOrganizationIds: string[] = [];
  const createdUserIds: string[] = [];
  const actor = { id: 'group-revision-admin', email: 'admin@example.com', name: 'Admin' };

  afterEach(async () => {
    for (const organizationId of createdOrganizationIds) {
      await db
        .delete(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
    }
    for (const kiloUserId of createdUserIds) {
      await db.delete(kilocode_users).where(eq(kilocode_users.id, kiloUserId));
    }
    createdOrganizationIds.length = 0;
    createdUserIds.length = 0;
  });

  async function createOrganization(policyRevision?: number) {
    const [organization] = await db
      .insert(organizations)
      .values({ name: 'Policy Revision Organization', plan: 'enterprise' })
      .returning();
    createdOrganizationIds.push(organization.id);
    if (policyRevision !== undefined) {
      await db
        .insert(organization_group_policy_settings)
        .values({ organization_id: organization.id, policy_revision: policyRevision });
    }
    return organization;
  }

  async function createGroup(organizationId: string, name: string) {
    const [group] = await db
      .insert(organization_groups)
      .values({ organization_id: organizationId, name })
      .returning();
    return group;
  }

  async function createMember(organizationId: string) {
    const user = await insertTestUser();
    createdUserIds.push(user.id);
    await db
      .insert(organization_memberships)
      .values({ organization_id: organizationId, kilo_user_id: user.id, role: 'member' });
    return user;
  }

  async function readSettingsRow(organizationId: string) {
    const [settings] = await db
      .select()
      .from(organization_group_policy_settings)
      .where(eq(organization_group_policy_settings.organization_id, organizationId));
    return settings;
  }

  async function readPolicyRevision(organizationId: string) {
    const [settings] = await db
      .select({
        policyRevision: organization_group_policy_settings.policy_revision,
      })
      .from(organization_group_policy_settings)
      .where(eq(organization_group_policy_settings.organization_id, organizationId));
    return settings?.policyRevision;
  }

  async function readGroupName(groupId: string) {
    const [group] = await db
      .select({ name: organization_groups.name })
      .from(organization_groups)
      .where(eq(organization_groups.id, groupId));
    return group?.name;
  }

  async function readGroupMemberships(groupId: string) {
    return await db
      .select()
      .from(organization_group_memberships)
      .where(eq(organization_group_memberships.group_id, groupId))
      .orderBy(organization_group_memberships.kilo_user_id);
  }

  type MembershipRow = typeof organization_group_memberships.$inferSelect;

  function membershipRow(rows: MembershipRow[], kiloUserId: string) {
    const row = rows.find(candidate => candidate.kilo_user_id === kiloUserId);
    if (!row) throw new Error(`Missing membership row for ${kiloUserId}`);
    return row;
  }

  async function policyAuditMessages(organizationId: string, action: AuditLogAction) {
    const rows = await db
      .select({
        action: organization_audit_logs.action,
        message: organization_audit_logs.message,
      })
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organizationId))
      .orderBy(organization_audit_logs.id);
    return rows.filter(row => row.action === action).map(row => row.message);
  }

  it('leaves the policy revision alone when a metadata rename changes no policy state', async () => {
    const organization = await createOrganization(4);
    const group = await createGroup(organization.id, 'Alpha');

    const { policyRevision } = await updateOrganizationGroupMetadata({
      organizationId: organization.id,
      groupId: group.id,
      actor,
      name: 'Alpha Renamed',
      description: 'Renamed only',
    });

    expect(policyRevision).toBe(4);
    expect(await readPolicyRevision(organization.id)).toBe(4);
    expect(await readGroupName(group.id)).toBe('Alpha Renamed');
  });

  it('creates the policy settings row at revision 1 for a rename in an organization that has none', async () => {
    const organization = await createOrganization();
    const group = await createGroup(organization.id, 'Bravo');

    const { policyRevision } = await updateOrganizationGroupMetadata({
      organizationId: organization.id,
      groupId: group.id,
      actor,
      name: 'Bravo Renamed',
    });

    expect(policyRevision).toBe(1);
    expect(await readSettingsRow(organization.id)).toMatchObject({
      policy_revision: 1,
      updated_by_kilo_user_id: actor.id,
    });
    expect(await readGroupName(group.id)).toBe('Bravo Renamed');
  });

  it('keeps membership rows byte-identical when a details save repeats the member set', async () => {
    const organization = await createOrganization(5);
    const group = await createGroup(organization.id, 'Charlie');
    const firstMember = await createMember(organization.id);
    const secondMember = await createMember(organization.id);
    await db.insert(organization_group_memberships).values(
      [firstMember.id, secondMember.id].map(kiloUserId => ({
        organization_id: organization.id,
        group_id: group.id,
        kilo_user_id: kiloUserId,
        assigned_by_kilo_user_id: 'seeded-by-another-admin',
      }))
    );
    const before = await readGroupMemberships(group.id);

    const { policyRevision } = await updateOrganizationGroupDetails({
      organizationId: organization.id,
      groupId: group.id,
      actor,
      name: 'Charlie Renamed',
      userIds: [secondMember.id, firstMember.id],
    });

    expect(before.map(row => row.assigned_by_kilo_user_id)).toEqual([
      'seeded-by-another-admin',
      'seeded-by-another-admin',
    ]);
    expect(await readGroupMemberships(group.id)).toEqual(before);
    expect(policyRevision).toBe(5);
    expect(await readPolicyRevision(organization.id)).toBe(5);
    expect(await readGroupName(group.id)).toBe('Charlie Renamed');
  });

  it('advances the policy revision by one and touches only the added and removed members', async () => {
    const organization = await createOrganization(6);
    const group = await createGroup(organization.id, 'Delta');
    const removedMember = await createMember(organization.id);
    const survivingMember = await createMember(organization.id);
    const addedMember = await createMember(organization.id);
    await db.insert(organization_group_memberships).values(
      [removedMember.id, survivingMember.id].map(kiloUserId => ({
        organization_id: organization.id,
        group_id: group.id,
        kilo_user_id: kiloUserId,
        assigned_by_kilo_user_id: 'seeded-by-another-admin',
      }))
    );
    const survivingBefore = membershipRow(await readGroupMemberships(group.id), survivingMember.id);

    const { policyRevision } = await updateOrganizationGroupDetails({
      organizationId: organization.id,
      groupId: group.id,
      actor,
      name: 'Delta',
      userIds: [survivingMember.id, addedMember.id],
    });

    expect(policyRevision).toBe(7);
    expect(await readPolicyRevision(organization.id)).toBe(7);
    const after = await readGroupMemberships(group.id);
    expect(after).toHaveLength(2);
    expect(membershipRow(after, survivingMember.id)).toEqual(survivingBefore);
    expect(membershipRow(after, addedMember.id)).toMatchObject({
      organization_id: organization.id,
      group_id: group.id,
      assigned_by_kilo_user_id: actor.id,
    });
    expect(after.some(row => row.kilo_user_id === removedMember.id)).toBe(false);
  });

  it('rewrites no membership row for an unchanged member group set and advances once for an added group', async () => {
    const organization = await createOrganization(8);
    const keptGroup = await createGroup(organization.id, 'Echo');
    const extraGroup = await createGroup(organization.id, 'Foxtrot');
    const user = await createMember(organization.id);
    await db.insert(organization_group_memberships).values({
      organization_id: organization.id,
      group_id: keptGroup.id,
      kilo_user_id: user.id,
      assigned_by_kilo_user_id: 'seeded-by-another-admin',
    });
    const before = await readGroupMemberships(keptGroup.id);

    const unchanged = await setOrganizationMemberGroups({
      organizationId: organization.id,
      actor,
      userId: user.id,
      groupIds: [keptGroup.id],
    });

    expect(unchanged.policyRevision).toBe(8);
    expect(await readPolicyRevision(organization.id)).toBe(8);
    expect(await readGroupMemberships(keptGroup.id)).toEqual(before);
    expect(membershipRow(before, user.id).assigned_by_kilo_user_id).toBe('seeded-by-another-admin');

    const added = await setOrganizationMemberGroups({
      organizationId: organization.id,
      actor,
      userId: user.id,
      groupIds: [keptGroup.id, extraGroup.id],
    });

    expect(added.policyRevision).toBe(9);
    expect(await readPolicyRevision(organization.id)).toBe(9);
    expect(await readGroupMemberships(keptGroup.id)).toEqual(before);
    expect(await readGroupMemberships(extraGroup.id)).toMatchObject([
      {
        organization_id: organization.id,
        kilo_user_id: user.id,
        assigned_by_kilo_user_id: actor.id,
      },
    ]);
  });

  it('leaves the revision alone when removing a policy the group lacks and bumps on deletion', async () => {
    const organization = await createOrganization(3);
    const group = await createGroup(organization.id, 'Golf');

    const removal = await removeOrganizationGroupPolicy({
      organizationId: organization.id,
      groupId: group.id,
      actor,
      policyType: 'model_access',
    });

    expect(removal.result).toEqual([]);
    expect(removal.policyRevision).toBe(3);
    expect(await readPolicyRevision(organization.id)).toBe(3);
    const removalMessages = await policyAuditMessages(
      organization.id,
      'organization.group.policy.remove'
    );
    expect(removalMessages).toEqual([
      `Removed model_access policy from group "Golf" (${group.id})`,
    ]);
    expect(removalMessages.join(' ')).not.toContain('revision');

    const deletion = await deleteOrganizationGroup({
      organizationId: organization.id,
      groupId: group.id,
      actor,
    });

    expect(deletion.policyRevision).toBe(4);
    expect(await readPolicyRevision(organization.id)).toBe(4);
  });

  it('keeps the revision and omits the revision clause when a policy write repeats the stored policy', async () => {
    const organization = await createOrganization(4);
    const group = await createGroup(organization.id, 'Hotel');
    const storedPolicy = {
      type: 'agent_permissions',
      data: {
        schema_version: 1,
        tools: { webfetch: 'deny', bash: 'ask' },
        shell: { bash: { fallback: 'ask', rules: [{ pattern: 'git *', action: 'allow' }] } },
      },
    } satisfies OrganizationGroupPolicy;
    const modelPolicy = {
      type: 'model_access',
      data: { mode: 'none' },
    } satisfies OrganizationGroupPolicy;
    // The stored rows hold the same content as the write below in another tool-key
    // order and another entry order, so only a content comparison sees them as equal.
    await db
      .update(organization_groups)
      .set({ policies: [storedPolicy, modelPolicy] })
      .where(eq(organization_groups.id, group.id));
    await db
      .update(organization_group_policy_settings)
      .set({ default_policies: [storedPolicy] })
      .where(eq(organization_group_policy_settings.organization_id, organization.id));

    const originalWriteSwitch = process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;
    const [existingConfig] = await db
      .select()
      .from(ai_gateway_config)
      .where(eq(ai_gateway_config.id, 1));
    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = 'true';
    await db
      .insert(ai_gateway_config)
      .values({ config: { organization_features: { org_permission_policy: [organization.id] } } })
      .onConflictDoUpdate({
        target: ai_gateway_config.id,
        set: { config: { organization_features: { org_permission_policy: [organization.id] } } },
      });
    try {
      const write = {
        type: 'agent_permissions',
        data: {
          schema_version: 1,
          tools: { bash: 'ask', webfetch: 'deny' },
          shell: { bash: { fallback: 'ask', rules: [{ pattern: 'git *', action: 'allow' }] } },
        },
      } satisfies OrganizationGroupPolicy;

      const groupWrite = await setOrganizationGroupPolicy({
        organizationId: organization.id,
        groupId: group.id,
        actor,
        policy: write,
      });
      const defaultWrite = await setDefaultOrganizationGroupPolicy({
        organizationId: organization.id,
        actor,
        policy: write,
      });

      expect(groupWrite.result).toEqual([modelPolicy, write]);
      expect(defaultWrite.result).toEqual([write]);
      expect(groupWrite.policyRevision).toBe(4);
      expect(defaultWrite.policyRevision).toBe(4);
      expect(await readPolicyRevision(organization.id)).toBe(4);
      expect(await readSettingsRow(organization.id)).toMatchObject({ policy_revision: 4 });

      const groupMessages = await policyAuditMessages(
        organization.id,
        'organization.group.policy.set'
      );
      const defaultMessages = await policyAuditMessages(
        organization.id,
        'organization.group.default_policy.set'
      );
      expect(groupMessages).toEqual([
        `Set agent_permissions policy for group "Hotel" (${group.id})`,
      ]);
      expect(defaultMessages).toEqual(['Set default agent_permissions group policy']);
      expect([...groupMessages, ...defaultMessages].join(' ')).not.toContain('revision');
    } finally {
      if (originalWriteSwitch === undefined)
        delete process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED;
      else process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED = originalWriteSwitch;
      if (existingConfig === undefined) {
        await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
      } else {
        await db
          .update(ai_gateway_config)
          .set({ config: existingConfig.config })
          .where(eq(ai_gateway_config.id, 1));
      }
    }
  });
});
