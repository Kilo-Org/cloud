import 'server-only';

import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import {
  DEFAULT_ORGANIZATION_MODEL_ACCESS_POLICY,
  OrganizationGroupPoliciesSchema,
  type OrganizationGroupPolicies,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';
import type { organization_group_policy_settings } from '@kilocode/db/schema';

export type OrganizationGroupPolicySettingsRow =
  typeof organization_group_policy_settings.$inferSelect;

export type CanonicalOrganizationGroupPolicySettings = {
  defaultPolicies: OrganizationGroupPolicies;
  policyRevision: number;
};

/**
 * The canonical view of an organization's group-policy settings: the stored
 * row, or the defaults at revision 0 when the organization has none yet. The
 * read path and the mutation wrapper share it so they cannot disagree about
 * the defaults or the parse options.
 */
export function canonicalSettingsFrom(
  settings: OrganizationGroupPolicySettingsRow | undefined,
  organizationId: string
): CanonicalOrganizationGroupPolicySettings {
  if (!settings) {
    return {
      defaultPolicies: DEFAULT_ORGANIZATION_GROUP_POLICIES,
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

/**
 * Policies an organization without a settings row is evaluated against, and the
 * defaults written when its first group policy mutation creates that row.
 */
export const DEFAULT_ORGANIZATION_GROUP_POLICIES = [
  DEFAULT_ORGANIZATION_MODEL_ACCESS_POLICY,
] satisfies OrganizationGroupPolicies;

export function parseOrganizationGroupPolicies(
  value: unknown,
  context: { organizationId: string; groupId?: string; source: 'group' | 'default' }
): OrganizationGroupPolicies {
  const parsed = OrganizationGroupPoliciesSchema.safeParse(
    Array.isArray(value)
      ? value.filter(
          (policy: unknown) =>
            !(
              typeof policy === 'object' &&
              policy !== null &&
              'type' in policy &&
              policy.type === 'client_access'
            )
        )
      : value
  );
  if (!parsed.success) {
    captureException(parsed.error, {
      tags: { domain: 'organization-groups', source: context.source },
      extra: {
        organizationId: context.organizationId,
        groupId: context.groupId,
      },
    });
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Organization group policy data is invalid',
    });
  }
  return parsed.data;
}

/** Parse the stored policies of one group. */
export function parseGroupPolicies(
  group: { id: string; policies: unknown },
  organizationId: string
): OrganizationGroupPolicies {
  return parseOrganizationGroupPolicies(group.policies, {
    organizationId,
    groupId: group.id,
    source: 'group',
  });
}
