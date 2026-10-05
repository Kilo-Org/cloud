import { canManageOrganizationBilling } from '@kilocode/app-shared/organizations';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useOrganization } from '@/lib/organization-context';
import { INFINITE_QUERY_MAX_PAGES, withInfiniteRetention } from '@/lib/query/infinite-retention';
import { useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/**
 * The current user's role in the active organization, resolved from the shared
 * membership list (`useOrganizationsList`).
 *
 * Pass `organizationIdOverride` to resolve role/membership against an explicit
 * org id (e.g. a deep-link `?org=` param) instead of the persisted selection.
 */
function useOrgRole(organizationIdOverride?: string) {
  const { organizationId: contextOrganizationId } = useOrganization();
  const organizationId = organizationIdOverride ?? contextOrganizationId;
  const { data: orgs, isLoading, isError, isFetching, refetch } = useOrganizationsList();
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
export type OrgMember = OrgWithMembers['members'][number];
export type ActiveOrgMember = Extract<OrgMember, { status: 'active' }>;
export type InvitedOrgMember = Extract<OrgMember, { status: 'invited' }>;

export function isActiveOrgMember(member: OrgMember): member is ActiveOrgMember {
  return member.status === 'active';
}

export function isInvitedOrgMember(member: OrgMember): member is InvitedOrgMember {
  return member.status === 'invited';
}

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

export type CreditTransaction =
  RouterOutputs['organizations']['creditTransactionsPage']['entries'][number];

/**
 * Whether the newest-first org lists have reached their retention bound.
 *
 * Both lists order `created_at desc`, so page one holds the newest entries and
 * each screen renders every retained page as one flattened list. The shared
 * `INFINITE_QUERY_MAX_PAGES` retention bound therefore has to be reached by
 * refusing the next page rather than by React Query's `maxPages` trim: a
 * forward fetch runs `addToEnd(pages, page, maxPages)`, which drops index 0
 * once the bound is exceeded, and index 0 is page one — the newest page. Left
 * to `maxPages` alone that silently removes the newest rows from the top of
 * the screen once a sixth page loads. Refusing the next page keeps every
 * loaded page retained; the hooks read `hasNextPage`, so "Load more"
 * disappears at the bound instead of paging into a silent no-op.
 */
function hasReachedRetentionBound(pageCount: number): boolean {
  return pageCount >= INFINITE_QUERY_MAX_PAGES;
}

/**
 * Build the credit-transactions infinite-query options. Kept as a pure builder
 * so the retention bound and the cursor passthrough are testable without
 * mounting the hook.
 */
export function buildOrgCreditTransactionsPageQueryOptions(
  trpc: ReturnType<typeof useTRPC>,
  organizationId: string | null
) {
  return withInfiniteRetention(
    trpc.organizations.creditTransactionsPage.infiniteQueryOptions(
      { organizationId: organizationId ?? '' },
      {
        enabled: organizationId != null,
        getNextPageParam: (lastPage, pages) =>
          lastPage.hasMore && !hasReachedRetentionBound(pages.length)
            ? (lastPage.nextCursor ?? undefined)
            : undefined,
      }
    )
  );
}

/**
 * Cursor-paginated credit transactions for an organization. Mirrors the legacy
 * `useOrgCreditTransactions` surface (flat `entries`) but pages through
 * `organizations.creditTransactionsPage` with `useInfiniteQuery` so the screen
 * can offer \"Load more\" instead of scanning every row at once.
 */
export function useOrgCreditTransactionsPage(organizationId: string | null) {
  const trpc = useTRPC();
  const query = useInfiniteQuery(buildOrgCreditTransactionsPageQueryOptions(trpc, organizationId));

  const pages = query.data?.pages;
  const entries = useMemo(() => (pages ?? []).flatMap(page => page.entries), [pages]);
  // `hasNextPage` folds the builder's refusal bound into the server's last-page
  // `hasMore`, so the "Load more" control hides at the retention bound.
  const hasMore = query.hasNextPage;

  return { query, entries, hasMore };
}

export type OrgInvoice = RouterOutputs['organizations']['invoicesPage']['entries'][number];

/**
 * Build the invoices infinite-query options. Kept as a pure builder so the
 * retention bound, the fixed `period: 'year'` input, and the cursor
 * passthrough are testable without mounting the hook.
 */
export function buildOrgInvoicesPageQueryOptions(
  trpc: ReturnType<typeof useTRPC>,
  organizationId: string | null
) {
  return withInfiniteRetention(
    trpc.organizations.invoicesPage.infiniteQueryOptions(
      { organizationId: organizationId ?? '', period: 'year' },
      {
        enabled: organizationId != null,
        getNextPageParam: (lastPage, pages) =>
          lastPage.hasMore && !hasReachedRetentionBound(pages.length)
            ? (lastPage.nextCursor ?? undefined)
            : undefined,
      }
    )
  );
}

/**
 * Cursor-paginated invoices for an organization. Mirrors the legacy
 * `useOrgInvoices` surface (flat `entries`) but pages through
 * `organizations.invoicesPage` with `useInfiniteQuery` so the screen can offer
 * \"Load more\" instead of loading every invoice at once.
 */
export function useOrgInvoicesPage(organizationId: string | null) {
  const trpc = useTRPC();
  const query = useInfiniteQuery(buildOrgInvoicesPageQueryOptions(trpc, organizationId));

  const pages = query.data?.pages;
  const entries = useMemo(() => (pages ?? []).flatMap(page => page.entries), [pages]);
  // `hasNextPage` folds the builder's refusal bound into the server's last-page
  // `hasMore`, so the "Load more" control hides at the retention bound.
  const hasMore = query.hasNextPage;

  return { query, entries, hasMore };
}
