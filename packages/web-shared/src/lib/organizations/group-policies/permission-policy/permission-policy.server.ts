import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { organization_groups, type Organization } from '@kilocode/db/schema';
import type {
  OrganizationGroupAgentPermissionsPolicy,
  OrganizationGroupPolicy,
} from '@kilocode/db/schema-types';
import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import { parseGroupPolicies } from '../organization-group-policies.server';
import {
  isOrganizationPermissionPolicyType,
  MemberPermissionPolicySchema,
  PERMISSION_POLICY_MAX_AGE_SECONDS,
  type OrganizationPermissionPolicy,
} from './permission-policy.schema';

function permissionPolicyWritesFlagEnabled(): boolean {
  return process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED === 'true';
}

async function resolveManaged(
  tx: DrizzleTransaction,
  organization: Organization
): Promise<boolean> {
  return (
    organization.plan === 'enterprise' &&
    isOrganizationFeatureEnabled(
      await readOrganizationFeatures(tx),
      'org_permission_policy',
      organization.id
    )
  );
}

export async function assertOrganizationPermissionPolicyWriteEnabled(
  organizationId: string,
  tx: DrizzleTransaction
): Promise<void> {
  if (
    !permissionPolicyWritesFlagEnabled() ||
    !isOrganizationFeatureEnabled(
      await readOrganizationFeatures(tx),
      'org_permission_policy',
      organizationId
    )
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization permission policy writes are disabled.',
    });
  }
}

export function permissionPolicies(
  policies: OrganizationGroupPolicy[]
): OrganizationPermissionPolicy[] {
  return policies.filter((policy): policy is OrganizationPermissionPolicy =>
    isOrganizationPermissionPolicyType(policy.type)
  );
}

function dedupeLayers<T>(layers: T[]): T[] {
  const seen = new Set<string>();
  return layers.filter(layer => {
    const key = JSON.stringify(layer);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function orderLayers<T>(layers: T[]): T[] {
  return layers
    .map(layer => ({ layer, key: JSON.stringify(layer) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ layer }) => layer);
}

function buildMemberPolicyResponse(params: {
  organizationId: string;
  managed: boolean;
  revision: number;
  policies: OrganizationGroupAgentPermissionsPolicy[];
}) {
  const agentLayers = orderLayers(dedupeLayers(params.policies.map(policy => policy.data)));
  return {
    schema_version: 1 as const,
    organization_id: params.organizationId,
    managed: params.managed,
    revision: params.revision,
    max_age_seconds: PERMISSION_POLICY_MAX_AGE_SECONDS,
    policy: {
      ...(agentLayers.length ? { agent_permissions: { layers: agentLayers } } : {}),
    },
  };
}

/**
 * Reject a definition write whose accepted result could never be served to a
 * member. The member payload is capped, so enforcing the cap at write time
 * keeps a valid stored configuration from producing a permanent 500.
 */
export async function assertOrganizationPermissionPolicyFits(
  organizationId: string,
  tx: DrizzleTransaction
): Promise<void> {
  const context = await getOrganizationGroupPolicyContext({
    tx,
    organizationId,
    subject: { type: 'defaultAccess' },
  });
  const groups = await tx
    .select({ id: organization_groups.id, policies: organization_groups.policies })
    .from(organization_groups)
    .where(eq(organization_groups.organization_id, organizationId));
  const policies = [
    ...context.defaultPolicies,
    ...groups.flatMap(group => parseGroupPolicies(group, organizationId)),
  ];
  const parsed = MemberPermissionPolicySchema.safeParse(
    buildMemberPolicyResponse({
      organizationId,
      managed: true,
      revision: context.policyRevision,
      policies: permissionPolicies(policies),
    })
  );
  if (!parsed.success) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Organization permission policy exceeds the maximum size that can be served to members. Remove or shorten policies before saving.',
    });
  }
}

export async function getStoredOrganizationPermissionPolicy(
  organizationId: string,
  groupId?: string
) {
  return await db.transaction(
    async tx => {
      const context = await getOrganizationGroupPolicyContext({
        tx,
        organizationId,
        subject: { type: 'defaultAccess' },
      });
      const managed = await resolveManaged(tx, context.organization);
      let policies = context.defaultPolicies;
      if (groupId) {
        const [group] = await tx
          .select({ policies: organization_groups.policies })
          .from(organization_groups)
          .where(
            and(
              eq(organization_groups.organization_id, organizationId),
              eq(organization_groups.id, groupId)
            )
          )
          .limit(1);
        if (!group) throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' });
        if (managed)
          policies = parseGroupPolicies({ id: groupId, policies: group.policies }, organizationId);
      }
      return {
        managed,
        writesEnabled: managed && permissionPolicyWritesFlagEnabled(),
        policies: managed ? permissionPolicies(policies) : [],
        policyRevision: context.policyRevision,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

export async function getOrganizationPermissionPolicy(organizationId: string, kiloUserId: string) {
  return await db.transaction(
    async tx => {
      const context = await getOrganizationGroupPolicyContext({
        tx,
        organizationId,
        subject: { type: 'member', kiloUserId },
      });
      const managed = await resolveManaged(tx, context.organization);
      const defaultPolicies = managed ? permissionPolicies(context.defaultPolicies) : [];
      const groups = managed
        ? context.groups.flatMap(group => {
            const policies = permissionPolicies(group.policies);
            return policies.length ? [{ groupId: group.id, policies }] : [];
          })
        : [];
      const validated = MemberPermissionPolicySchema.safeParse(
        buildMemberPolicyResponse({
          organizationId: context.organization.id,
          managed,
          revision: context.policyRevision,
          policies: [...defaultPolicies, ...groups.flatMap(group => group.policies)],
        })
      );
      if (!validated.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Effective organization policy is invalid.',
        });
      }
      return { response: validated.data, sources: { defaultPolicies, groups } };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}
