import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { organization_groups } from '@kilocode/db/schema';
import type { OrganizationGroupPolicy } from '@kilocode/db/schema-types';
import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationGroupPolicyContext } from '@kilocode/web-shared/lib/organizations/organization-group-policy-context.server';
import { parseOrganizationGroupPolicies } from '../organization-group-policies.server';
import {
  type AgentPermissionSet,
  type MemberPermissionPolicy,
  MemberPermissionPolicySchema,
  type OrganizationPermissionPolicy,
  PERMISSION_POLICY_MAX_AGE_SECONDS,
  PERMISSION_POLICY_OS_ADDITIONS,
  type PermissionPolicyExecutionOs,
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

function permissionPolicies(policies: OrganizationGroupPolicy[]): OrganizationPermissionPolicy[] {
  return policies.filter(policy => policy.type !== 'model_access');
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
  policies: OrganizationPermissionPolicy[];
  executionOs?: PermissionPolicyExecutionOs;
}): MemberPermissionPolicy {
  const envelope = {
    schema_version: 1 as const,
    organization_id: params.organizationId,
    revision: params.revision,
    max_age_seconds: PERMISSION_POLICY_MAX_AGE_SECONDS,
  };
  if (!params.managed) return { ...envelope, managed: false, policy: {} };

  const generic: (AgentPermissionSet & { schema_version: 1 })[] = [];
  const additions: typeof generic = [];
  const os = params.executionOs;
  let showSessionDollarValues: boolean | undefined;
  for (const policy of params.policies) {
    if (policy.type === 'client_configuration') {
      showSessionDollarValues =
        (showSessionDollarValues ?? true) && policy.data.show_session_dollar_values;
    } else {
      const { by_os, ...allOs } = policy.data;
      generic.push(allOs);
      const addition = os && os !== 'other' ? by_os?.[os] : undefined;
      if (addition) additions.push({ schema_version: 1, ...addition });
    }
  }
  const layers = dedupeLayers([...orderLayers(generic), ...orderLayers(additions)]);
  return {
    ...envelope,
    managed: true,
    policy: {
      ...(layers.length ? { agent_permissions: { layers } } : {}),
      ...(showSessionDollarValues !== undefined
        ? { client_configuration: { show_session_dollar_values: showSessionDollarValues } }
        : {}),
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
  const policies = permissionPolicies([
    ...context.defaultPolicies,
    ...groups.flatMap(group =>
      parseOrganizationGroupPolicies(group.policies, {
        organizationId,
        groupId: group.id,
        source: 'group',
      })
    ),
  ]);
  const fits = [undefined, ...PERMISSION_POLICY_OS_ADDITIONS].every(
    executionOs =>
      MemberPermissionPolicySchema.safeParse(
        buildMemberPolicyResponse({
          organizationId,
          managed: true,
          revision: context.policyRevision,
          policies,
          executionOs,
        })
      ).success
  );
  if (!fits) {
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

export async function getOrganizationPermissionPolicy(
  organizationId: string,
  kiloUserId: string,
  executionOs?: PermissionPolicyExecutionOs
) {
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
      const validated = MemberPermissionPolicySchema.safeParse(
        buildMemberPolicyResponse({
          organizationId: context.organization.id,
          managed,
          revision: context.policyRevision,
          policies: [...defaultPolicies, ...groups.flatMap(group => group.policies)],
          executionOs,
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
