import 'server-only';

import {
  kilocode_users,
  organization_group_memberships,
  organization_group_policy_links,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organizations,
  type Organization,
  type OrganizationGroup,
} from '@kilocode/db/schema';
import {
  MAX_ORGANIZATION_GROUPS,
  OrganizationSettingsSchema,
  type NamedOrganizationPolicyKind,
} from '@kilocode/db/schema-types';
import {
  describeModelAccessPolicyWriteRefusal,
  OrganizationGroupPoliciesSchema,
  OrganizationGroupModelAccessPolicyWriteSchema,
  OrganizationGroupPolicySchema,
  ORGANIZATION_GROUPS_ENTERPRISE_ONLY_MESSAGE,
  type OrganizationGroupPolicies,
  type OrganizationGroupPolicy,
  type OrganizationGroupPolicyType,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import {
  assertOrganizationPermissionPolicyFits,
  assertOrganizationPermissionPolicyWriteEnabled,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.server';
import { and, asc, count, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import {
  enkryptInputGuardrailGroupId,
  resolveEnkryptInputGuardrail,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { normalizeRegisteredOrganizationGroupPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/registry.server';
import {
  DEFAULT_ORGANIZATION_GROUP_POLICIES,
  parseOrganizationGroupPolicies,
  canonicalSettingsFrom,
  type CanonicalOrganizationGroupPolicySettings,
  type OrganizationGroupPolicySettingsRow,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies.server';

type OrganizationGroupActor = {
  id: string;
  email: string;
  name: string;
};

type NamedGroupPolicyLink = {
  policyId: string;
  kind: NamedOrganizationPolicyKind;
};

export type { CanonicalOrganizationGroupPolicySettings } from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies.server';

export type OrganizationGroupWithMembers = OrganizationGroup & {
  policies: OrganizationGroupPolicies;
  memberIds: string[];
};

export function normalizeOrganizationGroupPolicy(
  policyInput: OrganizationGroupPolicy
): OrganizationGroupPolicy {
  const policy = OrganizationGroupPolicySchema.parse(policyInput);
  const normalized = normalizeRegisteredOrganizationGroupPolicy(policy);
  if (normalized.type !== 'model_access') return normalized;
  const parsed = OrganizationGroupModelAccessPolicyWriteSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: describeModelAccessPolicyWriteRefusal(parsed.error),
      cause: parsed.error,
    });
  }
  return parsed.data;
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

/**
 * Serialize a policy with its object keys sorted, so two policies that differ
 * only in key order serialize identically. Array order is the order stored,
 * because a rule list is matched in the order it was written.
 */
function stablePolicyJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stablePolicyJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stablePolicyJson(entry)}`)
    .join(',')}}`;
}

/** The content of one policy, with the model allow lists compared as the sets they are. */
function policyContent(policy: OrganizationGroupPolicy): string {
  if (policy.type !== 'model_access' || policy.data.mode !== 'selected') {
    return stablePolicyJson(policy);
  }
  return stablePolicyJson({
    type: policy.type,
    data: {
      mode: policy.data.mode,
      model_allow_list: [...policy.data.model_allow_list].sort(),
      provider_allow_list: [...policy.data.provider_allow_list].sort(),
    },
  });
}

/** Whether two policy lists hold the same content, whatever their entry order. */
function samePolicies(left: OrganizationGroupPolicies, right: OrganizationGroupPolicies): boolean {
  if (left.length !== right.length) return false;
  const rightContent = new Map(right.map(policy => [policy.type, policyContent(policy)]));
  return left.every(policy => rightContent.get(policy.type) === policyContent(policy));
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
      message: ORGANIZATION_GROUPS_ENTERPRISE_ONLY_MESSAGE,
    });
  }
  return organization;
}

export async function lockOrganizationGroupPolicy(tx: DrizzleTransaction, organizationId: string) {
  await tx.execute(sql`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${`organization-group-policy:${organizationId.toLowerCase()}`}, 0)
    )
  `);
}

async function getSettingsRow(
  organizationId: string,
  client: typeof db | DrizzleTransaction = db
): Promise<OrganizationGroupPolicySettingsRow | undefined> {
  const [settings] = await client
    .select()
    .from(organization_group_policy_settings)
    .where(eq(organization_group_policy_settings.organization_id, organizationId))
    .limit(1);
  return settings;
}

/** Create the settings row at revision 1. Callers hold the policy advisory lock. */
async function createOrganizationGroupPolicySettingsRow(
  tx: DrizzleTransaction,
  organizationId: string,
  actorUserId: string | null
) {
  await tx.insert(organization_group_policy_settings).values({
    organization_id: organizationId,
    default_policies: DEFAULT_ORGANIZATION_GROUP_POLICIES,
    policy_revision: 1,
    updated_by_kilo_user_id: actorUserId,
  });
}

/** Publish `policyRevision` on an existing settings row. */
async function writeOrganizationGroupPolicyRevision(
  tx: DrizzleTransaction,
  organizationId: string,
  actorUserId: string | null,
  policyRevision: number
) {
  await tx
    .update(organization_group_policy_settings)
    .set({
      policy_revision: policyRevision,
      updated_by_kilo_user_id: actorUserId,
      updated_at: sql`now()`,
    })
    .where(eq(organization_group_policy_settings.organization_id, organizationId));
}

export async function bumpOrganizationGroupPolicyRevision(
  tx: DrizzleTransaction,
  organizationId: string,
  actorUserId: string | null
) {
  await lockOrganizationGroupPolicy(tx, organizationId);
  const existing = await getSettingsRow(organizationId, tx);
  if (!existing) {
    await createOrganizationGroupPolicySettingsRow(tx, organizationId, actorUserId);
    return 1;
  }
  const policyRevision = existing.policy_revision + 1;
  await writeOrganizationGroupPolicyRevision(tx, organizationId, actorUserId, policyRevision);
  return policyRevision;
}

export async function getOrganizationGroupPolicySettings(
  organizationId: string,
  client: typeof db | DrizzleTransaction = db
): Promise<CanonicalOrganizationGroupPolicySettings> {
  await assertEnterpriseOrganization(organizationId, client);
  return canonicalSettingsFrom(await getSettingsRow(organizationId, client), organizationId);
}

/**
 * Run `mutate` under the organization's policy advisory lock. The settings row
 * is created at revision 1 when absent; afterwards the revision advances only
 * when `mutate` reports `policyStateChanged`, and the returned `policyRevision`
 * is the revision actually published.
 */
export async function withOrganizationGroupPolicyMutation<T>(
  organizationId: string,
  actorUserId: string,
  mutate: (params: {
    tx: DrizzleTransaction;
    organization: Organization;
    currentSettings: CanonicalOrganizationGroupPolicySettings;
    /**
     * The revision this mutation would publish: the stored revision plus one,
     * or 1 when the mutation creates the settings row. It is a prediction until
     * the mutation returns `policyStateChanged`, so an audit message names it
     * only on a path that reports a change.
     */
    pendingPolicyRevision: number;
  }) => Promise<{ result: T; policyStateChanged: boolean }>
): Promise<{ result: T; policyRevision: number }> {
  return await db.transaction(async tx => {
    await lockOrganizationGroupPolicy(tx, organizationId);
    const organization = await assertEnterpriseOrganization(organizationId, tx);
    const existingSettings = await getSettingsRow(organizationId, tx);
    const currentSettings = canonicalSettingsFrom(existingSettings, organizationId);
    const nextPolicyRevision = existingSettings ? existingSettings.policy_revision + 1 : 1;

    if (!existingSettings) {
      await createOrganizationGroupPolicySettingsRow(tx, organizationId, actorUserId);
    }

    const { result, policyStateChanged } = await mutate({
      tx,
      organization,
      currentSettings,
      pendingPolicyRevision: nextPolicyRevision,
    });

    if (!existingSettings) return { result, policyRevision: 1 };
    if (!policyStateChanged) return { result, policyRevision: existingSettings.policy_revision };
    await writeOrganizationGroupPolicyRevision(tx, organizationId, actorUserId, nextPolicyRevision);
    return { result, policyRevision: nextPolicyRevision };
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

async function listOrganizationGroupMemberIds(
  tx: DrizzleTransaction,
  organizationId: string,
  groupId: string
): Promise<string[]> {
  const rows = await tx
    .select({ userId: organization_group_memberships.kilo_user_id })
    .from(organization_group_memberships)
    .where(
      and(
        eq(organization_group_memberships.organization_id, organizationId),
        eq(organization_group_memberships.group_id, groupId)
      )
    );
  return rows.map(({ userId }) => userId);
}

/** Delete only the removed ids and insert only the added ids, keeping unchanged rows intact. */
async function applyOrganizationGroupMemberDiff(
  tx: DrizzleTransaction,
  organizationId: string,
  groupId: string,
  diff: { added: string[]; removed: string[] },
  actorId: string
) {
  if (diff.removed.length > 0) {
    await tx
      .delete(organization_group_memberships)
      .where(
        and(
          eq(organization_group_memberships.organization_id, organizationId),
          eq(organization_group_memberships.group_id, groupId),
          inArray(organization_group_memberships.kilo_user_id, diff.removed)
        )
      );
  }
  if (diff.added.length > 0) {
    await tx.insert(organization_group_memberships).values(
      diff.added.map(userId => ({
        organization_id: organizationId,
        group_id: groupId,
        kilo_user_id: userId,
        assigned_by_kilo_user_id: actorId,
      }))
    );
  }
}

function diffMemberIds(current: string[], next: string[]) {
  const currentIds = new Set(current);
  const nextIds = new Set(next);
  const added = next.filter(id => !currentIds.has(id));
  const removed = current.filter(id => !nextIds.has(id));
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

function permissionPolicyTypes(policies: OrganizationGroupPolicies) {
  return policies.map(policy => policy.type).filter(type => type !== 'model_access');
}

function groupPermissionPolicyTypes(
  group: Pick<OrganizationGroup, 'id' | 'organization_id' | 'policies'>
) {
  return permissionPolicyTypes(
    parseOrganizationGroupPolicies(group.policies, {
      organizationId: group.organization_id,
      groupId: group.id,
      source: 'group',
    })
  );
}

async function getActiveNamedGroupPolicyLinks(
  tx: DrizzleTransaction,
  organizationId: string,
  groupIds: string[]
): Promise<NamedGroupPolicyLink[]> {
  if (groupIds.length === 0) return [];
  const links = await tx
    .selectDistinct({
      policyId: organization_group_policy_links.policy_id,
      kind: organization_group_policy_links.kind,
    })
    .from(organization_group_policy_links)
    .where(
      and(
        eq(organization_group_policy_links.organization_id, organizationId),
        inArray(organization_group_policy_links.group_id, groupIds)
      )
    )
    .orderBy(
      asc(organization_group_policy_links.kind),
      asc(organization_group_policy_links.policy_id)
    );
  if (links.length === 0) return [];
  return isOrganizationFeatureEnabled(
    await readOrganizationFeatures(tx),
    'org_permission_policy',
    organizationId
  )
    ? links
    : [];
}

async function guardGroupPermissionPolicyChange(
  tx: DrizzleTransaction,
  organizationId: string,
  policyTypes: OrganizationGroupPolicyType[],
  permissionPolicyAdmin: boolean | undefined,
  namedPolicies: NamedGroupPolicyLink[] = []
) {
  if (policyTypes.length === 0 && namedPolicies.length === 0) return;
  if (!permissionPolicyAdmin) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Use a browser session to change organization permission policy.',
    });
  }
  await assertOrganizationPermissionPolicyWriteEnabled(organizationId, tx);
}

async function guardGroupMembershipChange(
  tx: DrizzleTransaction,
  group: OrganizationGroup,
  current: string[],
  userIds: string[],
  permissionPolicyAdmin: boolean | undefined
) {
  const policyTypes = groupPermissionPolicyTypes(group);
  const namedPolicies = await getActiveNamedGroupPolicyLinks(tx, group.organization_id, [group.id]);
  if (policyTypes.length === 0 && namedPolicies.length === 0) return { policyTypes, namedPolicies };
  const nextUserIds = new Set(userIds);
  if (current.length === nextUserIds.size && current.every(userId => nextUserIds.has(userId))) {
    return { policyTypes: [], namedPolicies: [] };
  }
  await guardGroupPermissionPolicyChange(
    tx,
    group.organization_id,
    policyTypes,
    permissionPolicyAdmin,
    namedPolicies
  );
  return { policyTypes, namedPolicies };
}

function permissionPolicyAuditSuffix(
  policyTypes: OrganizationGroupPolicyType[],
  revision: number,
  namedPolicies: NamedGroupPolicyLink[] = []
) {
  const embeddedSuffix =
    policyTypes.length > 0
      ? `; permission policy: ${policyTypes.join(', ')} (revision ${revision})`
      : '';
  const namedSuffix =
    namedPolicies.length > 0
      ? `; named policies: ${namedPolicies.map(({ kind, policyId }) => `${kind} ${policyId}`).join(', ')} (revision ${revision})`
      : '';
  return embeddedSuffix + namedSuffix;
}

function actorAudit(actor: OrganizationGroupActor) {
  return {
    actor_id: actor.id,
    actor_email: actor.email,
    actor_name: actor.name,
  };
}

function counted(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
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

  const memberIdsByGroupId = new Map<string, string[]>();
  for (const membership of memberships) {
    const memberIds = memberIdsByGroupId.get(membership.groupId);
    if (memberIds) {
      memberIds.push(membership.userId);
    } else {
      memberIdsByGroupId.set(membership.groupId, [membership.userId]);
    }
  }

  return groups.map(group => ({
    ...group,
    policies: parseOrganizationGroupPolicies(group.policies, {
      organizationId,
      groupId: group.id,
      source: 'group',
    }),
    memberIds: memberIdsByGroupId.get(group.id) ?? [],
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
  permissionPolicyAdmin?: boolean;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx, pendingPolicyRevision }) => {
      const policies = OrganizationGroupPoliciesSchema.parse(
        params.policies.map(normalizeOrganizationGroupPolicy)
      );
      const policyTypes = permissionPolicyTypes(policies);
      await guardGroupPermissionPolicyChange(
        tx,
        params.organizationId,
        policyTypes,
        params.permissionPolicyAdmin
      );
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
      if (policyTypes.length > 0) {
        await assertOrganizationPermissionPolicyFits(params.organizationId, tx);
      }
      await createAuditLog({
        action: 'organization.group.create',
        ...actorAudit(params.actor),
        message: `Created group "${group.name}" (${group.id})${permissionPolicyAuditSuffix(policyTypes, pendingPolicyRevision)}`,
        organization_id: params.organizationId,
        tx,
      });
      return { result: { ...group, policies }, policyStateChanged: policies.length > 0 };
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
      return { result: updated, policyStateChanged: false };
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
  permissionPolicyAdmin?: boolean;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx, pendingPolicyRevision }) => {
      const existing = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      await assertGroupNameAvailable(tx, params.organizationId, params.name.trim(), params.groupId);
      const userIds = [...new Set(params.userIds)];
      await assertDirectMembers(tx, params.organizationId, userIds);
      const currentMemberIds = await listOrganizationGroupMemberIds(
        tx,
        params.organizationId,
        params.groupId
      );
      const memberDiff = diffMemberIds(currentMemberIds, userIds);
      const { policyTypes, namedPolicies } = await guardGroupMembershipChange(
        tx,
        existing,
        currentMemberIds,
        userIds,
        params.permissionPolicyAdmin
      );
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
      await applyOrganizationGroupMemberDiff(
        tx,
        params.organizationId,
        params.groupId,
        memberDiff,
        params.actor.id
      );
      await createAuditLog({
        action: 'organization.group.update',
        ...actorAudit(params.actor),
        message: `Updated group "${existing.name}" (${existing.id}) with ${counted(userIds.length, 'member', 'members')}${permissionPolicyAuditSuffix(policyTypes, pendingPolicyRevision, namedPolicies)}`,
        organization_id: params.organizationId,
        tx,
      });
      return {
        result: { ...group, memberIds: userIds },
        policyStateChanged: memberDiff.changed,
      };
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
    async ({ tx, pendingPolicyRevision }) => {
      const group = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      if (params.policy.type !== 'model_access') {
        await assertOrganizationPermissionPolicyWriteEnabled(params.organizationId, tx);
      }
      const currentPolicies = parseOrganizationGroupPolicies(group.policies, {
        organizationId: params.organizationId,
        groupId: group.id,
        source: 'group',
      });
      const policies = upsertPolicy(currentPolicies, params.policy);
      const policyStateChanged = !samePolicies(policies, currentPolicies);
      await tx
        .update(organization_groups)
        .set({ policies, updated_at: sql`now()` })
        .where(
          and(
            eq(organization_groups.organization_id, params.organizationId),
            eq(organization_groups.id, params.groupId)
          )
        );
      if (params.policy.type !== 'model_access') {
        await assertOrganizationPermissionPolicyFits(params.organizationId, tx);
      }
      await createAuditLog({
        action: 'organization.group.policy.set',
        ...actorAudit(params.actor),
        message: policyStateChanged
          ? `Set ${params.policy.type} policy for group "${group.name}" (${group.id}) at revision ${pendingPolicyRevision}`
          : `Set ${params.policy.type} policy for group "${group.name}" (${group.id})`,
        organization_id: params.organizationId,
        tx,
      });
      return { result: policies, policyStateChanged };
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
    async ({ tx, pendingPolicyRevision }) => {
      const group = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      if (params.policyType !== 'model_access') {
        await assertOrganizationPermissionPolicyWriteEnabled(params.organizationId, tx);
      }
      const currentPolicies = parseOrganizationGroupPolicies(group.policies, {
        organizationId: params.organizationId,
        groupId: group.id,
        source: 'group',
      });
      const policies = currentPolicies.filter(policy => policy.type !== params.policyType);
      const policyStateChanged = !samePolicies(policies, currentPolicies);
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
        message: policyStateChanged
          ? `Removed ${params.policyType} policy from group "${group.name}" (${group.id}) at revision ${pendingPolicyRevision}`
          : `Removed ${params.policyType} policy from group "${group.name}" (${group.id})`,
        organization_id: params.organizationId,
        tx,
      });
      return { result: policies, policyStateChanged };
    }
  );
}

export async function setOrganizationGroupMembers(params: {
  organizationId: string;
  groupId: string;
  actor: OrganizationGroupActor;
  userIds: string[];
  permissionPolicyAdmin?: boolean;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx, pendingPolicyRevision }) => {
      const group = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      const userIds = [...new Set(params.userIds)];
      await assertDirectMembers(tx, params.organizationId, userIds);
      const currentMemberIds = await listOrganizationGroupMemberIds(
        tx,
        params.organizationId,
        params.groupId
      );
      const memberDiff = diffMemberIds(currentMemberIds, userIds);
      const { policyTypes, namedPolicies } = await guardGroupMembershipChange(
        tx,
        group,
        currentMemberIds,
        userIds,
        params.permissionPolicyAdmin
      );
      await applyOrganizationGroupMemberDiff(
        tx,
        params.organizationId,
        params.groupId,
        memberDiff,
        params.actor.id
      );
      await createAuditLog({
        action: 'organization.group.members.set',
        ...actorAudit(params.actor),
        message: `Set ${counted(userIds.length, 'member', 'members')} for group "${group.name}" (${group.id})${permissionPolicyAuditSuffix(policyTypes, pendingPolicyRevision, namedPolicies)}`,
        organization_id: params.organizationId,
        tx,
      });
      return { result: userIds, policyStateChanged: memberDiff.changed };
    }
  );
}

export async function setOrganizationMemberGroups(params: {
  organizationId: string;
  userId: string;
  actor: OrganizationGroupActor;
  groupIds: string[];
  permissionPolicyAdmin?: boolean;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx, pendingPolicyRevision }) => {
      const groupIds = [...new Set(params.groupIds.map(groupId => groupId.toLowerCase()))];
      const nextGroupIds = new Set(groupIds);
      await assertDirectMembers(tx, params.organizationId, [params.userId]);
      const groups = await tx
        .select({
          id: organization_groups.id,
          organization_id: organization_groups.organization_id,
          policies: organization_groups.policies,
          currentGroupId: organization_group_memberships.group_id,
        })
        .from(organization_groups)
        .leftJoin(
          organization_group_memberships,
          and(
            eq(organization_group_memberships.organization_id, organization_groups.organization_id),
            eq(organization_group_memberships.group_id, organization_groups.id),
            eq(organization_group_memberships.kilo_user_id, params.userId)
          )
        )
        .where(
          and(
            eq(organization_groups.organization_id, params.organizationId),
            or(
              inArray(organization_groups.id, groupIds),
              isNotNull(organization_group_memberships.group_id)
            )
          )
        );
      if (groups.filter(group => nextGroupIds.has(group.id)).length !== nextGroupIds.size) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'One or more groups are invalid.' });
      }
      const memberGroupDiff = diffMemberIds(
        groups.filter(group => group.currentGroupId !== null).map(group => group.id),
        groupIds
      );
      // One comparison decides both the guard and the revision: the rows the
      // diff adds or removes are the groups whose policy leaves or joins this
      // member's effective policy.
      const changedGroupIds = new Set([...memberGroupDiff.added, ...memberGroupDiff.removed]);
      const changedGroups = groups.filter(group => changedGroupIds.has(group.id));
      const policyTypes = [...new Set(changedGroups.flatMap(groupPermissionPolicyTypes))].sort();
      const namedPolicies = await getActiveNamedGroupPolicyLinks(
        tx,
        params.organizationId,
        changedGroups.map(group => group.id)
      );
      await guardGroupPermissionPolicyChange(
        tx,
        params.organizationId,
        policyTypes,
        params.permissionPolicyAdmin,
        namedPolicies
      );
      let auditTarget = `organization member (${params.userId})`;
      if (namedPolicies.length === 0) {
        const [member] = await tx
          .select({ email: kilocode_users.google_user_email })
          .from(kilocode_users)
          .where(eq(kilocode_users.id, params.userId))
          .limit(1);
        auditTarget = `organization member ${member?.email ?? params.userId} (${params.userId})`;
      }
      if (memberGroupDiff.removed.length > 0) {
        await tx
          .delete(organization_group_memberships)
          .where(
            and(
              eq(organization_group_memberships.organization_id, params.organizationId),
              eq(organization_group_memberships.kilo_user_id, params.userId),
              inArray(organization_group_memberships.group_id, memberGroupDiff.removed)
            )
          );
      }
      if (memberGroupDiff.added.length > 0) {
        // No group row lock serializes this path, so a concurrent write for the
        // same member can insert the same row between the read above and this
        // insert. A duplicate add is a no-op, not a conflict.
        await tx
          .insert(organization_group_memberships)
          .values(
            memberGroupDiff.added.map(groupId => ({
              organization_id: params.organizationId,
              group_id: groupId,
              kilo_user_id: params.userId,
              assigned_by_kilo_user_id: params.actor.id,
            }))
          )
          .onConflictDoNothing();
      }
      await createAuditLog({
        action: 'organization.group.member_groups.set',
        ...actorAudit(params.actor),
        message: `Set ${counted(groupIds.length, 'group', 'groups')} for ${auditTarget}${permissionPolicyAuditSuffix(policyTypes, pendingPolicyRevision, namedPolicies)}`,
        organization_id: params.organizationId,
        tx,
      });
      return { result: groupIds, policyStateChanged: memberGroupDiff.changed };
    }
  );
}

/**
 * A group that an active Enkrypt input guardrail is limited to cannot be deleted, because the
 * guardrail would then scan nobody. An inactive guardrail forgets the group, so it applies to every
 * member if it is turned on again.
 */
async function releaseEnkryptInputGuardrailGroup(
  tx: DrizzleTransaction,
  organizationId: string,
  group: Pick<OrganizationGroup, 'id' | 'name'>,
  actor: OrganizationGroupActor
) {
  const [organization] = await tx
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for('update');
  const settings = organization?.settings;
  const inputGuardrail = settings?.enkrypt?.input_guardrail;
  if (!inputGuardrail || enkryptInputGuardrailGroupId(settings) !== group.id) return;
  if (resolveEnkryptInputGuardrail(organizationId, settings) !== null) {
    throw new TRPCError({
      code: 'CONFLICT',
      message:
        'Input guardrails are limited to this group. Choose another group on the AI Guardrails page first.',
    });
  }
  await tx
    .update(organizations)
    .set({
      settings: OrganizationSettingsSchema.parse({
        ...settings,
        enkrypt: { ...settings.enkrypt, input_guardrail: { ...inputGuardrail, group_id: null } },
      }),
    })
    .where(eq(organizations.id, organizationId));
  await createAuditLog({
    action: 'organization.settings.change',
    ...actorAudit(actor),
    message: `Updated AI guardrails: input guardrails now apply to all members because group "${group.name}" (${group.id}) was deleted`,
    organization_id: organizationId,
    tx,
  });
}

export async function deleteOrganizationGroup(params: {
  organizationId: string;
  groupId: string;
  actor: OrganizationGroupActor;
  permissionPolicyAdmin?: boolean;
}) {
  return await withOrganizationGroupPolicyMutation(
    params.organizationId,
    params.actor.id,
    async ({ tx, pendingPolicyRevision }) => {
      const group = await getGroupForUpdate(tx, params.organizationId, params.groupId);
      const policyTypes = groupPermissionPolicyTypes(group);
      const namedPolicies = await getActiveNamedGroupPolicyLinks(tx, params.organizationId, [
        group.id,
      ]);
      await guardGroupPermissionPolicyChange(
        tx,
        params.organizationId,
        policyTypes,
        params.permissionPolicyAdmin,
        namedPolicies
      );
      await releaseEnkryptInputGuardrailGroup(tx, params.organizationId, group, params.actor);
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
        message: `Deleted group "${group.name}" (${group.id})${permissionPolicyAuditSuffix(policyTypes, pendingPolicyRevision, namedPolicies)}`,
        organization_id: params.organizationId,
        tx,
      });
      return { result: group.id, policyStateChanged: true };
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
    async ({ tx, currentSettings, pendingPolicyRevision }) => {
      if (params.policy.type !== 'model_access') {
        await assertOrganizationPermissionPolicyWriteEnabled(params.organizationId, tx);
      }
      const defaultPolicies = upsertPolicy(currentSettings.defaultPolicies, params.policy);
      const policyStateChanged = !samePolicies(defaultPolicies, currentSettings.defaultPolicies);
      await tx
        .update(organization_group_policy_settings)
        .set({ default_policies: defaultPolicies, updated_at: sql`now()` })
        .where(eq(organization_group_policy_settings.organization_id, params.organizationId));
      if (params.policy.type !== 'model_access') {
        await assertOrganizationPermissionPolicyFits(params.organizationId, tx);
      }
      await createAuditLog({
        action: 'organization.group.default_policy.set',
        ...actorAudit(params.actor),
        message: policyStateChanged
          ? `Set default ${params.policy.type} group policy at revision ${pendingPolicyRevision}`
          : `Set default ${params.policy.type} group policy`,
        organization_id: params.organizationId,
        tx,
      });
      return { result: defaultPolicies, policyStateChanged };
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
    async ({ tx, currentSettings, pendingPolicyRevision }) => {
      if (params.policyType !== 'model_access') {
        await assertOrganizationPermissionPolicyWriteEnabled(params.organizationId, tx);
      }
      const defaultPolicies = currentSettings.defaultPolicies.filter(
        policy => policy.type !== params.policyType
      );
      const policyStateChanged = !samePolicies(defaultPolicies, currentSettings.defaultPolicies);
      await tx
        .update(organization_group_policy_settings)
        .set({ default_policies: defaultPolicies, updated_at: sql`now()` })
        .where(eq(organization_group_policy_settings.organization_id, params.organizationId));
      await createAuditLog({
        action: 'organization.group.default_policy.remove',
        ...actorAudit(params.actor),
        message: policyStateChanged
          ? `Removed default ${params.policyType} group policy at revision ${pendingPolicyRevision}`
          : `Removed default ${params.policyType} group policy`,
        organization_id: params.organizationId,
        tx,
      });
      return { result: defaultPolicies, policyStateChanged };
    }
  );
}
