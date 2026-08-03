import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/lib/auth/auth-context';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

/**
 * The current user's role in the active organization. `trpc.organizations.list`
 * requires auth (not an active org selection), so it's gated on the token
 * rather than on `organizationId` — mirrors profile-screen's `orgs` query.
 *
 * Pass `organizationIdOverride` to resolve role/membership against an explicit
 * org id (e.g. a deep-link `?org=` param) instead of the persisted selection.
 */
function useOrgRole(organizationIdOverride?: string) {
  const trpc = useTRPC();
  const { token } = useAuth();
  const { organizationId: contextOrganizationId } = useOrganization();
  const organizationId = organizationIdOverride ?? contextOrganizationId;
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
  return {
    organizationId,
    contextOrganizationId,
    role: org?.role,
    org,
    orgs,
    isLoading,
    isError,
    isFetching,
    refetch,
  };
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
 *
 * Optional `organizationIdOverride` replaces the context id end-to-end (list
 * lookup and returned `organizationId`) for deep-link visits.
 */
export function useOrgBoundary(organizationIdOverride?: string) {
  const { isLoaded } = useOrganization();
  const {
    organizationId,
    contextOrganizationId,
    role,
    org,
    orgs,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useOrgRole(organizationIdOverride);
  const isResolving = !isLoaded || isLoading;
  return {
    organizationId,
    contextOrganizationId,
    role,
    org,
    orgs,
    isResolving,
    isLoading,
    isError,
    isFetching,
    refetch,
  };
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
type OrgMember = OrgWithMembers['members'][number];
export type ActiveOrgMember = Extract<OrgMember, { status: 'active' }>;
export type InvitedOrgMember = Extract<OrgMember, { status: 'invited' }>;

/**
 * Parent organization's Kilo Pass for Orgs summary. The API is restricted to
 * the parent agreement owner (`organizationParentBillingProcedure` rejects
 * child orgs and non-billing roles), so `enabled` must only be true when the
 * user has a billing-capable role AND `withMembers` confirmed
 * `parent_organization_id === null` — children must never fire this query.
 */
export function useOrgKiloPassSummary(organizationId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.kiloPass.summary.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: enabled && organizationId != null }
    )
  );
}

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
