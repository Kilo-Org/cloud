import 'server-only';

import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import {
  DEFAULT_ORGANIZATION_MODEL_ACCESS_POLICY,
  OrganizationGroupPoliciesSchema,
  type OrganizationGroupPolicies,
} from '@kilocode/web-shared/lib/organizations/group-policies/organization-group-policies';

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
  const parsed = OrganizationGroupPoliciesSchema.safeParse(value);
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
