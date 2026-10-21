import { useQuery } from '@tanstack/react-query';

import {
  classifyOrganizationScopeAccess,
  type OrganizationScopeAccess,
} from '@/lib/organization-scope-access';
import { useTRPC } from '@/lib/trpc';

/**
 * Access to one organization scope, from the shared membership list plus the
 * errors of the queries that carry that organization's data.
 *
 * Pass `undefined` for a personal scope: it has no membership to resolve and is
 * never denied by this rule. See `classifyOrganizationScopeAccess` for the
 * precedence between a denial code, a missing organization row and a list that
 * has not settled yet.
 */
export function useOrganizationScopeAccess(
  organizationId: string | undefined,
  errors: readonly unknown[]
): OrganizationScopeAccess {
  // Same cache entry as every other membership reader, so this never adds a
  // request the app has not already made.
  const trpc = useTRPC();
  const { data: organizations } = useQuery(trpc.organizations.list.queryOptions());
  return classifyOrganizationScopeAccess({
    organizationId,
    membershipIds: organizations?.map(organization => organization.organizationId),
    errors,
  });
}
