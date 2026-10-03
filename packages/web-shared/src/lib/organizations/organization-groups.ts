import 'server-only';

import { captureException } from '@sentry/nextjs';
import {
  organization_group_memberships,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organizations,
  type Organization,
  type OrganizationGroup,
} from '@kilocode/db/schema';
import { MAX_ORGANIZATION_GROUPS } from '@kilocode/db/schema-types';
import {
  OrganizationGroupPoliciesSchema,
  OrganizationGroupPolicySchema,
  type OrganizationGroupPolicies,
  type OrganizationGroupPolicy,
  type OrganizationGroupPolicyType,
} from '@/lib/organizations/group-policies/organization-group-policies';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { normalizeRegisteredOrganizationGroupPolicy } from '@/lib/organizations/group-policies/registry.server';

const DEFAULT_POLICIES = [
  { type: 'model_access', data: { mode: 'all' } },
] satisfies OrganizationGroupPolicies;

type OrganizationGroupActor = {
  id: string;
  email: string;
  name: string;
};

export type CanonicalOrganizationGroupPolicySettings = {
  defaultPolicies: OrganizationGroupPolicies;
  policyRevision: number;
};

export type OrganizationGroupWithMembers = OrganizationGroup & {
  policies: OrganizationGroupPolicies;
  memberIds: string[];
};

function reportInvalidPolicies(params: {
  error: unknown;
  organizationId: string;
  groupId?: string;
  source: 'group' | 'default';
}) {
  captureException(params.error, {
    tags: { domain: 'organization-groups', source: params.source },
    extra: {
      organizationId: params.organizationId,
      groupId: params.groupId,
    },
  });
}

export function parseOrganizationGroupPolicies(
  value: unknown,
  context: { organizationId: string; groupId?: string; source: 'group' | 'default' }
): OrganizationGroupPolicies {
  const parsed = OrganizationGroupPoliciesSchema.safeParse(value);
  if (!parsed.success) {
    reportInvalidPolicies({ error: parsed.error, ...context });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Organization group policy data is invalid',
    });
  }
  return parsed.data;
}

export function normalizeOrganizationGroupPolicy(
  policyInput: OrganizationGroupPolicy
): OrganizationGroupPolicy {
  const policy = OrganizationGroupPolicySchema.parse(policyInput);
  return normalizeRegisteredOrganizationGroupPolicy(policy);
}

function upsertPolicy(
  policies: OrganizationGroupPolicies,
  policy: OrganizationGroupPolicy
): OrganizationGroupPolicies {
  return OrganizationGroupPoliciesSchema.parse([
    ...policies.filter(existing => existing.type !== policy.type),
    normalizeOrganizationGroupPolicy(policy),
  ]);
}

async function assertEnterpriseOrganization(
  organizationId: string,
  client: typeof db | DrizzleTransaction = db
): Promise<Organization> {
  const [organization] = await client
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), sql`${organizations.deleted_at} IS NULL`))
    .limit(1);

  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  if (organization.plan !== 'enterprise') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Groups are available to Enterprise organizations.',
    });
  }
  return organization;
}

async function acquireOrganizationPolicyLock(tx: DrizzleTransaction, organizationId: string) {
  await tx.execute(sql`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${`organization-group-policy:${organizationId}`}, 0)
    )
  `);
}

export async function bumpOrganizationGroupPolicyRevision(
  tx: DrizzleTransaction,
  organizationId: string,
  actorUserId: string | null
) {
  await acquireOrganizationPolicyLock(tx, organizationId);
  const existing = await getSettingsRow(organizationId, tx);
  if (!existing) {
    await tx.insert(organization_group_policy_settings).values({
      organization_id: organizationId,
      default_policies: DEFAULT_POLICIES,
      policy_revision: 1,
      updated_by_kilo_user_id: actorUserId,
    });
    return 1;
  }
  const policyRevision = existing.policy_revision + 1;
  await tx
    .update(organization_group_policy_settings)
    .set({
      policy_revision: policyRevision,
      updated_by_kilo_user_id: actorUserId,
      updated_at: sql`now()`,
    })
    .where(eq(organization_group_policy_settings.organization_id, organizationId));
  return policyRevision;
}

async function getSettingsRow(organizationId: string, client: typeof db | DrizzleTransaction = db) {
  const [settings] = await client
    .select()
    .from(organization_group_policy_settings)
    .where(eq(organization_group_policy_settings.organization_id, organizationId))
    .limit(1);
  return settings;
}

export async function getOrganizationGroupPolicySettings(
  organizationId: string,
  client: typeof db | DrizzleTransaction = db
): Promise<CanonicalOrganizationGroupPolicySettings> {
  await assertEnterpriseOrganization(organizationId, client);
  const settings = await getSettingsRow(organizationId, client);
  if (!settings) {
    return {
      defaultPolicies: DEFAULT_POLICIES,
      policyRevision: 0,
    };
  }
  return {
    defaultPolicies: parseOrganizationGroupPolicies(settings.default_policies, {
      organizationId,
      source: 'default',
    }),
    policyRevision: settings.policy_revision,
  };
}

export async function withOrganizationGroupPolicyMutation<T>(
  organizationId: string,
  actorUserId: string,
  mutate: (params: {
    tx: DrizzleTransaction;
    organization: Organization;
    currentSettings: CanonicalOrganizationGroupPolicySettings;
  }) => Promise<T>
): Promise<{ result: T; policyRevision: number }> {
  return await db.transaction(async tx => {
    await acquireOrganizationPolicyLock(tx, organizationId);
    const organization = await assertEnterpriseOrganization(organizationId, tx);
    const existingSettings = await getSettingsRow(organizationId, tx);
    const currentSettings = existingSettings
      ? {
          defaultPolicies: parseOrganizationGroupPolicies(existingSettings.default_policies, {
            organizationId,
            source: 'default',
          }),
          policyRevision: existingSettings.policy_revision,
        }
      : {
          defaultPolicies: DEFAULT_POLICIES,
          policyRevision: 0,
        };

    if (!existingSettings) {
      await tx.insert(organization_group_policy_settings).values({
        organization_id: organizationId,
        default_policies: currentSettings.defaultPolicies,
        policy_revision: 1,
        updated_by_kilo_user_id: actorUserId,
      });
    }

    const result = await mutate({ tx, organization, currentSettings });
    const policyRevision = existingSettings ? existingSettings.policy_revision + 1 : 1;

    if (existingSettings) {
      await tx
        .update(organization_group_policy_settings)
        .set({
          policy_revision: policyRevision,
          updated_by_kilo_user_id: actorUserId,
          updated_at: sql`now()`,
        })
        .where(eq(organization_group_policy_settings.organization_id, organizationId));
    }

    return { result, policyRevision };
  });
}

async function getGroupForUpdate(tx: DrizzleTransaction, organizationId: string, groupId: string) {
  const [group] = await tx
    .select()
    .from(organization_groups)
    .where(
      and(
        eq(organization_groups.organization_id, organizationId),
        eq(organization_groups.id, groupId)
      )
    )
    .for('update')
    .limit(1);
  if (!group) throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
  return group;
}

async function assertDirectMembers(
  tx: DrizzleTransaction,
  organizationId: string,
  userIds: string[]
) {
  if (userIds.length === 0) return;
  const uniqueIds = [...new Set(userIds)];
  const rows = await tx
    .select({ userId: organization_memberships.kilo_user_id })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        inArray(organization_memberships.kilo_user_id, uniqueIds)
      )
    );
  if (rows.length !== uniqueIds.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Every group member must be a direct organization member.',
    });
  }
}

async function assertGroups(tx: DrizzleTransaction, organizationId: string, groupIds: string[]) {
  if (groupIds.length === 0) return;
  const uniqueIds = [...new Set(groupIds)];
  const rows = await tx
    .select({ id: organization_groups.id })
    .from(organization_groups)
    .where(
      and(
        eq(organization_groups.organization_id, organizationId),
        inArray(organization_groups.id, uniqueIds)
      )
    );
  if (rows.length !== uniqueIds.length) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'One or more groups are invalid.' });
  }
}

function actorAudit(actor: OrganizationGroupActor) {
  return {
    actor_id: actor.id,
    actor_email: actor.email,
    actor_name: actor.name,
  };
}

/**
 * Reject a group name that collides (case- and whitespace-insensitively) with
 * an existing group in the same organization, so both create and rename return
 * a typed `CONFLICT` instead of surfacing the
 * `UQ_organization_groups_organization_id_canonical_name` violation as a 500.
 * Pass `excludeGroupId` when renaming so the group does not conflict with
 * itself.
 */
async function assertGroupNameAvailable(
  tx: DrizzleTransaction,
  organizationId: string,
  canonicalName: string,
  excludeGroupId?: string
) {
  const [duplicate] = await tx
    .select({ id: organization_groups.id })
    .from(organization_groups)
    .where(
      and(
        eq(organization_groups.organization_id, organizationId),
        sql`lower(btrim(${organization_groups.name})) = lower(btrim(${canonicalName}))`,
        excludeGroupId ? sql`${organization_groups.id} <> ${excludeGroupId}` : sql`true`
      )
    )
    .limit(1);
  if (duplicate) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'A group with this name already exists.',
    });
  }
}

export async function listOrganizationGroupsForManager(
  organizationId: string
): Promise<OrganizationGroupWithMembers[]> {
  await assertEnterpriseOrganization(organizationId);
  const groups = await db
    .select()
    .from(organization_groups)
    .where(eq(organization_groups.organization_id, organizationId))
    .orderBy(asc(organization_groups.name));
  const memberships = await db
    .select({
      groupId: organization_group_memberships.group_id,
      userId: organization_group_memberships.kilo_user_id,
    })
    .from(organization_group_memberships)
    .where(eq(organization_group_memberships.organization_id, organizationId));

  return groups.map(group => ({
    ...group,
    policies: parseOrganizationGroupPolicies(group.policies, {
      organizationId,
      groupId: group.id,
      source: 'group',
    }),
    memberIds: memberships.filter(row => row.groupId === group.id).map(row => row.userId),
  }));
}

export async function listOrganizationGroupsForMember(
  organizationId: string,
  userId: string
): Promise<Array<Pick<OrganizationGroup, 'id' | 'name' | 'description'>>> {
  await assertEnterpriseOrganization(organizationId);
  return await db
    .select({
      id: organization_groups.id,
      name: organization_groups.name,
      description: organization_groups.description,
    })
    .from(organization_group_memberships)
    .innerJoin(
      organization_groups,
      and(
        eq(organization_groups.organization_id, organization_group_memberships.organization_id),
        eq(organization_groups.id, organization_group_memberships.group_id)
      )
    )
    .where(
      and(
        eq(organization_group_memberships.organization_id, organizationId),
        eq(organization_group_memberships.kilo_user_id, userId)
      )
    )
    .orderBy(asc(organization_groups.name));
}

export async function createOrganizationGroup(params: {
  organizationId: string;
  actor: OrganizationGroupActor;
  name: string;
  description?: string | null;
  policies: OrganizationGroupPolicies;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx }) => {
      const [{ value: groupCount }] = await tx
        .select({ value: count() })
        .from(organization_groups)
        .where(eq(organization_groups.organization_id, params.organizationId));
      if (groupCount >= MAX_ORGANIZATION_GROUPS) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `An organization can have at most ${MAX_ORGANIZATION_GROUPS} groups.`,
        });
      }

      const canonicalName = params.name.trim();
      await assertGroupNameAvailable(tx, params.organizationId, canonicalName);

      const policies = OrganizationGroupPoliciesSchema.parse(
        params.policies.map(normalizeOrganizationGroupPolicy)
      );
      const [group] = await tx
        .insert(organization_groups)
        .values({
          organization_id: params.organizationId,
          name: canonicalName,
          description: params.description ?? null,
          policies,
          created_by_kilo_user_id: params.actor.id,
        })
        .returning();
      await createAuditLog({
        action: 'organization.group.create',
        ...actorAudit(params.actor),
        message: `Created group "${group.name}" (${group.id})`,
        organization_id: params.organizationId,
        tx,
      });
      return { ...group, policies };
    }
  );
}

export async function updateOrganizationGroupMetadata(params: {
  organizationId: string;
  groupId: string;
  actor: OrganizationGroupActor;
  name?: string;
  description?: string | null;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx }) => {
      const existing = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      if (params.name !== undefined) {
        await assertGroupNameAvailable(
          tx,
          params.organizationId,
          params.name.trim(),
          params.groupId
        );
      }
      const [updated] = await tx
        .update(organization_groups)
        .set({
          ...(params.name !== undefined ? { name: params.name.trim() } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(organization_groups.organization_id, params.organizationId),
            eq(organization_groups.id, params.groupId)
          )
        )
        .returning();
      await createAuditLog({
        action: 'organization.group.update',
        ...actorAudit(params.actor),
        message: `Updated group "${existing.name}" (${existing.id})`,
        organization_id: params.organizationId,
        tx,
      });
      return updated;
    }
  );
}

export async function updateOrganizationGroupDetails(params: {
  organizationId: string;
  groupId: string;
  actor: OrganizationGroupActor;
  name: string;
  description?: string | null;
  userIds: string[];
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx }) => {
      const existing = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      await assertGroupNameAvailable(tx, params.organizationId, params.name.trim(), params.groupId);
      const userIds = [...new Set(params.userIds)];
      await assertDirectMembers(tx, params.organizationId, userIds);
      const [group] = await tx
        .update(organization_groups)
        .set({
          name: params.name.trim(),
          description: params.description ?? null,
          updated_at: sql`now()`,
        })
        .where(
          and(
            eq(organization_groups.organization_id, params.organizationId),
            eq(organization_groups.id, params.groupId)
          )
        )
        .returning();
      await tx
        .delete(organization_group_memberships)
        .where(
          and(
            eq(organization_group_memberships.organization_id, params.organizationId),
            eq(organization_group_memberships.group_id, params.groupId)
          )
        );
      if (userIds.length > 0) {
        await tx.insert(organization_group_memberships).values(
          userIds.map(userId => ({
            organization_id: params.organizationId,
            group_id: params.groupId,
            kilo_user_id: userId,
            assigned_by_kilo_user_id: params.actor.id,
          }))
        );
      }
      await createAuditLog({
        action: 'organization.group.update',
        ...actorAudit(params.actor),
        message: `Updated group "${existing.name}" (${existing.id}) with ${userIds.length} members`,
        organization_id: params.organizationId,
        tx,
      });
      return { ...group, memberIds: userIds };
    }
  );
}

export async function setOrganizationGroupPolicy(params: {
  organizationId: string;
  groupId: string;
  actor: OrganizationGroupActor;
  policy: OrganizationGroupPolicy;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx }) => {
      const group = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      const policies = upsertPolicy(
        parseOrganizationGroupPolicies(group.policies, {
          organizationId: params.organizationId,
          groupId: group.id,
          source: 'group',
        }),
        params.policy
      );
      await tx
        .update(organization_groups)
        .set({ policies, updated_at: sql`now()` })
        .where(
          and(
            eq(organization_groups.organization_id, params.organizationId),
            eq(organization_groups.id, params.groupId)
          )
        );
      await createAuditLog({
        action: 'organization.group.policy.set',
        ...actorAudit(params.actor),
        message: `Set ${params.policy.type} policy for group "${group.name}" (${group.id})`,
        organization_id: params.organizationId,
        tx,
      });
      return policies;
    }
  );
}

export async function removeOrganizationGroupPolicy(params: {
  organizationId: string;
  groupId: string;
  actor: OrganizationGroupActor;
  policyType: OrganizationGroupPolicyType;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx }) => {
      const group = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      const policies = parseOrganizationGroupPolicies(group.policies, {
        organizationId: params.organizationId,
        groupId: group.id,
        source: 'group',
      }).filter(policy => policy.type !== params.policyType);
      await tx
        .update(organization_groups)
        .set({ policies, updated_at: sql`now()` })
        .where(
          and(
            eq(organization_groups.organization_id, params.organizationId),
            eq(organization_groups.id, params.groupId)
          )
        );
      await createAuditLog({
        action: 'organization.group.policy.remove',
        ...actorAudit(params.actor),
        message: `Removed ${params.policyType} policy from group "${group.name}" (${group.id})`,
        organization_id: params.organizationId,
        tx,
      });
      return policies;
    }
  );
}

export async function setOrganizationGroupMembers(params: {
  organizationId: string;
  groupId: string;
  actor: OrganizationGroupActor;
  userIds: string[];
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx }) => {
      const group = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      const userIds = [...new Set(params.userIds)];
      await assertDirectMembers(tx, params.organizationId, userIds);
      await tx
        .delete(organization_group_memberships)
        .where(
          and(
            eq(organization_group_memberships.organization_id, params.organizationId),
            eq(organization_group_memberships.group_id, params.groupId)
          )
        );
      if (userIds.length > 0) {
        await tx.insert(organization_group_memberships).values(
          userIds.map(userId => ({
            organization_id: params.organizationId,
            group_id: params.groupId,
            kilo_user_id: userId,
            assigned_by_kilo_user_id: params.actor.id,
          }))
        );
      }
      await createAuditLog({
        action: 'organization.group.members.set',
        ...actorAudit(params.actor),
        message: `Set ${userIds.length} members for group "${group.name}" (${group.id})`,
        organization_id: params.organizationId,
        tx,
      });
      return userIds;
    }
  );
}

export async function setOrganizationMemberGroups(params: {
  organizationId: string;
  userId: string;
  actor: OrganizationGroupActor;
  groupIds: string[];
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx }) => {
      const groupIds = [...new Set(params.groupIds)];
      await assertDirectMembers(tx, params.organizationId, [params.userId]);
      await assertGroups(tx, params.organizationId, groupIds);
      await tx
        .delete(organization_group_memberships)
        .where(
          and(
            eq(organization_group_memberships.organization_id, params.organizationId),
            eq(organization_group_memberships.kilo_user_id, params.userId)
          )
        );
      if (groupIds.length > 0) {
        await tx.insert(organization_group_memberships).values(
          groupIds.map(groupId => ({
            organization_id: params.organizationId,
            group_id: groupId,
            kilo_user_id: params.userId,
            assigned_by_kilo_user_id: params.actor.id,
          }))
        );
      }
      await createAuditLog({
        action: 'organization.group.member_groups.set',
        ...actorAudit(params.actor),
        message: `Set ${groupIds.length} groups for organization member ${params.userId}`,
        organization_id: params.organizationId,
        tx,
      });
      return groupIds;
    }
  );
}

export async function deleteOrganizationGroup(params: {
  organizationId: string;
  groupId: string;
  actor: OrganizationGroupActor;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx }) => {
      const group = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      await tx
        .delete(organization_groups)
        .where(
          and(
            eq(organization_groups.organization_id, params.organizationId),
            eq(organization_groups.id, params.groupId)
          )
        );
      await createAuditLog({
        action: 'organization.group.delete',
        ...actorAudit(params.actor),
        message: `Deleted group "${group.name}" (${group.id})`,
        organization_id: params.organizationId,
        tx,
      });
      return group.id;
    }
  );
}

export async function setDefaultOrganizationGroupPolicy(params: {
  organizationId: string;
  actor: OrganizationGroupActor;
  policy: OrganizationGroupPolicy;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx, currentSettings }) => {
      const defaultPolicies = upsertPolicy(currentSettings.defaultPolicies, params.policy);
      await tx
        .update(organization_group_policy_settings)
        .set({ default_policies: defaultPolicies, updated_at: sql`now()` })
        .where(eq(organization_group_policy_settings.organization_id, params.organizationId));
      await createAuditLog({
        action: 'organization.group.default_policy.set',
        ...actorAudit(params.actor),
        message: `Set default ${params.policy.type} group policy`,
        organization_id: params.organizationId,
        tx,
      });
      return defaultPolicies;
    }
  );
}

export async function removeDefaultOrganizationGroupPolicy(params: {
  organizationId: string;
  actor: OrganizationGroupActor;
  policyType: OrganizationGroupPolicyType;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx, currentSettings }) => {
      const defaultPolicies = currentSettings.defaultPolicies.filter(
        policy => policy.type !== params.policyType
      );
      await tx
        .update(organization_group_policy_settings)
        .set({ default_policies: defaultPolicies, updated_at: sql`now()` })
        .where(eq(organization_group_policy_settings.organization_id, params.organizationId));
      await createAuditLog({
        action: 'organization.group.default_policy.remove',
        ...actorAudit(params.actor),
        message: `Removed default ${params.policyType} group policy`,
        organization_id: params.organizationId,
        tx,
      });
      return defaultPolicies;
    }
  );
}
