import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/lib/auth/auth-context';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

/**
 * The current user's role in the active organization. `trpc.organizations.list`
 * requires auth (not an active org selection), so it's gated on the token
 * rather than on `organizationId` — mirrors profile-screen's `orgs` query.
 */
export function useOrgRole() {
  const trpc = useTRPC();
  const { token } = useAuth();
  const { organizationId } = useOrganization();
  const {
    data: orgs,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: token != null,
  });
  const org = orgs?.find(entry => entry.organizationId === organizationId);
  return { organizationId, role: org?.role, org, isLoading, isError, isFetching, refetch };
}

export type OrgListEntry = NonNullable<ReturnType<typeof useOrgRole>['org']>;
export type OrgRole = OrgListEntry['role'];

export const isMoneyRole = canManageOrganizationBilling;

/**
 * Reconciles the persisted org selection (SecureStore, read via
 * `useOrganization()`) against the loaded org list. `organizationId` alone
 * isn't enough to know a route is safe to render: it can be stale (the org
 * was deleted, or the user was removed from it) after the value round-trips
 * through storage, so screens must wait for both to settle and confirm the
 * selected id still resolves to a real membership before mounting forms or
 * firing mutations with it. Callers still check `organizationId`/`org` for
 * null themselves (rather than relying on a computed `isValid` flag) so
 * TypeScript narrows both to non-null after the guard.
 */
export function useOrgBoundary() {
  const { isLoaded } = useOrganization();
  const { organizationId, role, org, isLoading, isError, isFetching, refetch } = useOrgRole();
  const isResolving = !isLoaded || isLoading;
  return { organizationId, role, org, isResolving, isError, isFetching, refetch };
}

export function useOrgWithMembers(organizationId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.withMembers.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: organizationId != null }
    )
  );
}

export type OrgWithMembers = NonNullable<ReturnType<typeof useOrgWithMembers>['data']>;
export type OrgMember = OrgWithMembers['members'][number];
export type ActiveOrgMember = Extract<OrgMember, { status: 'active' }>;
export type InvitedOrgMember = Extract<OrgMember, { status: 'invited' }>;

export function useOrgUsageStats(organizationId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.usageStats.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: organizationId != null }
    )
  );
}

export function useOrgCreditTransactions(organizationId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.creditTransactions.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: organizationId != null }
    )
  );
}

export type CreditTransaction = NonNullable<
  ReturnType<typeof useOrgCreditTransactions>['data']
>[number];

export function useOrgInvoices(organizationId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.invoices.queryOptions(
      { organizationId: organizationId ?? '', period: 'year' },
      { enabled: organizationId != null }
    )
  );
}

export type OrgInvoice = NonNullable<ReturnType<typeof useOrgInvoices>['data']>[number];
