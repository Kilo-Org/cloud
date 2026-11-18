import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/lib/auth/auth-context';
import { useTRPC } from '@/lib/trpc';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';

/**
 * The current user's memberships. `trpc.organizations.list` requires auth (not
 * an active org selection), so it's gated on the token rather than on
 * `organizationId` — mirrors profile-screen's `orgs` query.
 *
 * One cache entry serves every consumer: role resolution, the boundary and the
 * organization provider's default-organization resolution all observe this
 * same query, so no consumer refetches a list another already has.
 *
 * This hook lives in its own module because the organization provider resolves
 * its default from this list, and the provider module is imported by
 * `use-organization-queries` (`useOrganization`); keeping the hook here lets
 * the provider read the list without importing that module back, which would
 * be a module cycle.
 */
export function useOrganizationsList() {
  const trpc = useTRPC();
  const { token } = useAuth();
  return useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: token != null,
    // The create flow awaits this read's refetch before it moves the
    // selection, so a paused (default `networkMode: 'online'`) refetch would
    // keep the create screen's submit busy for the whole outage even after the
    // create itself succeeded. Settle the read, like every screen whose flow
    // waits on it.
    ...SETTLE_WHILE_OFFLINE,
  });
}
