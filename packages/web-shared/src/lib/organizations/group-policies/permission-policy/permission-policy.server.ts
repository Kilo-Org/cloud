import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { organization_groups } from '@kilocode/db/schema';
import type {
  OrganizationGroupAgentPermissionsPolicy,
  OrganizationGroupClientAccessPolicy,
  OrganizationGroupPolicy,
} from '@kilocode/db/schema-types';
import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import { parseOrganizationGroupPolicies } from '../organization-group-policies.server';
import {
  MemberPermissionPolicySchema,
  PERMISSION_POLICY_MAX_AGE_SECONDS,
} from './permission-policy.schema';

export async function assertOrganizationPermissionPolicyWriteEnabled(
  organizationId: string,
  tx: DrizzleTransaction
): Promise<void> {
  if (
    process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED !== 'true' ||
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

function permissionPolicies(policies: OrganizationGroupPolicy[]) {
  return policies.filter(policy => policy.type !== 'model_access');
}

function orderLayers<T>(layers: T[]): T[] {
  return layers
    .map(layer => ({ layer, key: JSON.stringify(layer) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ layer }) => layer);
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
      const managed =
        context.organization.plan === 'enterprise' &&
        isOrganizationFeatureEnabled(
          await readOrganizationFeatures(tx),
          'org_permission_policy',
          context.organization.id
        );
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
          policies = parseOrganizationGroupPolicies(group.policies, {
            organizationId,
            groupId,
            source: 'group',
          });
      }
      return {
        managed,
        writesEnabled: managed && process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED === 'true',
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
      const managed =
        context.organization.plan === 'enterprise' &&
        isOrganizationFeatureEnabled(
          await readOrganizationFeatures(tx),
          'org_permission_policy',
          context.organization.id
        );
      const defaultPolicies = managed ? permissionPolicies(context.defaultPolicies) : [];
      const groups = managed
        ? context.groupIds.flatMap((groupId, index) => {
            const policies = permissionPolicies(context.groupPolicies[index]);
            return policies.length ? [{ groupId, policies }] : [];
          })
        : [];
      const agentLayers: OrganizationGroupAgentPermissionsPolicy['data'][] = [];
      const clientLayers: OrganizationGroupClientAccessPolicy['data'][] = [];
      for (const policy of [...defaultPolicies, ...groups.flatMap(group => group.policies)]) {
        if (policy.type === 'agent_permissions') agentLayers.push(policy.data);
        else clientLayers.push(policy.data);
      }
      const validated = MemberPermissionPolicySchema.safeParse({
        schema_version: 1,
        organization_id: context.organization.id,
        managed,
        revision: context.policyRevision,
        max_age_seconds: PERMISSION_POLICY_MAX_AGE_SECONDS,
        policy: {
          ...(agentLayers.length
            ? { agent_permissions: { layers: orderLayers(agentLayers) } }
            : {}),
          ...(clientLayers.length ? { client_access: { layers: orderLayers(clientLayers) } } : {}),
        },
      });
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
