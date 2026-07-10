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
  const { data: orgs, isLoading } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: token != null,
  });
  const org = orgs?.find(entry => entry.organizationId === organizationId);
  return { organizationId, role: org?.role, org, isLoading };
}

export type OrgListEntry = NonNullable<ReturnType<typeof useOrgRole>['org']>;
export type OrgRole = OrgListEntry['role'];

export function isMoneyRole(role: OrgRole | undefined): boolean {
  return role === 'owner' || role === 'billing_manager';
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
