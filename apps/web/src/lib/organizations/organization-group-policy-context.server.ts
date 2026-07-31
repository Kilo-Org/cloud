import 'server-only';

import {
  organization_group_memberships,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organizations,
  type Organization,
} from '@kilocode/db/schema';
import {
  OrganizationGroupPoliciesSchema,
  type OrganizationGroupPolicies,
} from '@/lib/organizations/group-policies/organization-group-policies';
import { and, eq, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';
import { db, type DrizzleTransaction } from '@/lib/drizzle';

export type OrganizationPolicySubject =
  | { type: 'member'; kiloUserId: string }
  | { type: 'defaultAccess' };

export type OrganizationGroupPolicyContext = {
  organization: Organization;
  defaultPolicies: OrganizationGroupPolicies;
  groupPolicies: OrganizationGroupPolicies[];
  policyRevision: number;
};

const DEFAULT_POLICIES = [
  { type: 'model_access', data: { mode: 'all' } },
] satisfies OrganizationGroupPolicies;

function parsePolicies(
  value: unknown,
  context: { organizationId: string; source: 'default' | 'group'; groupId?: string }
) {
  const parsed = OrganizationGroupPoliciesSchema.safeParse(value);
  if (!parsed.success) {
    captureException(parsed.error, {
      tags: { domain: 'organization-groups', source: context.source },
      extra: { organizationId: context.organizationId, groupId: context.groupId },
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Organization group policy data is invalid',
    });
  }
  return parsed.data;
}

/**
 * Resolve the organization the policy is evaluated against.
 *
 * Callers that already loaded and authorized the row pass it in, so the policy
 * reflects the same organization the request authorized instead of a second read
 * that could disagree with it.
 */
async function resolveOrganization(
  client: typeof db | DrizzleTransaction,
  params: { organizationId: string; organization?: Organization }
): Promise<Organization> {
  if (params.organization) {
    if (params.organization.id !== params.organizationId) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Organization group policy context received a mismatched organization',
      });
    }
    // Soft-deleted organizations must fail closed here too.
    if (params.organization.deleted_at) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }
    return params.organization;
  }
  const [organization] = await client
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, params.organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  return organization;
}

export async function getOrganizationGroupPolicyContext(params: {
  organizationId: string;
  subject: OrganizationPolicySubject;
  /** Organization row the caller already loaded; avoids re-reading it. */
  organization?: Organization;
  tx?: DrizzleTransaction;
}): Promise<OrganizationGroupPolicyContext> {
  if (!params.tx) {
    return await db.transaction(
      async tx => await getOrganizationGroupPolicyContext({ ...params, tx }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
  }
  const client = params.tx ?? db;
  const organization = await resolveOrganization(client, params);

  if (params.subject.type === 'member') {
    const [membership] = await client
      .select({ userId: organization_memberships.kilo_user_id })
      .from(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, params.organizationId),
          eq(organization_memberships.kilo_user_id, params.subject.kiloUserId)
        )
      )
      .limit(1);
    if (!membership) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'You do not have direct access to this organization',
      });
    }
  }

  const [settings] = await client
    .select()
    .from(organization_group_policy_settings)
    .where(eq(organization_group_policy_settings.organization_id, params.organizationId))
    .limit(1);

  const defaultPolicies = settings
    ? (parsePolicies(settings.default_policies, {
        organizationId: params.organizationId,
        source: 'default',
      }) as OrganizationGroupPolicies)
    : DEFAULT_POLICIES;

  let groupPolicies: OrganizationGroupPolicies[] = [];
  if (params.subject.type === 'member') {
    const groups = await client
      .select({ id: organization_groups.id, policies: organization_groups.policies })
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
          eq(organization_group_memberships.organization_id, params.organizationId),
          eq(organization_group_memberships.kilo_user_id, params.subject.kiloUserId)
        )
      );
    groupPolicies = groups.map(
      group =>
        parsePolicies(group.policies, {
          organizationId: params.organizationId,
          groupId: group.id,
          source: 'group',
        }) as OrganizationGroupPolicies
    );
  }

  return {
    organization,
    defaultPolicies,
    groupPolicies,
    policyRevision: settings?.policy_revision ?? 0,
  };
}
