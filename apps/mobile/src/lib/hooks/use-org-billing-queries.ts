import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { hasRetentionBudget, withInfiniteRetention } from '@/lib/query/infinite-retention';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { trpcClient, useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/**
 * The organization's seat subscription. `enabled` must be the billing role's
 * own answer: the procedure is `organizationBillingProcedure`, so a member's
 * request would be refused rather than answered emptily.
 */
export function useOrgSeatSubscription(organizationId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.subscription.get.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: enabled && organizationId != null }
    )
  );
}

/**
 * Seats used against seats purchased. `organizationMemberProcedure`, so every
 * member may read it — and it answers without a Stripe round trip, which is why
 * the seats row does not wait on the subscription read.
 */
export function useOrgSeats(organizationId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.seats.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: organizationId != null }
    )
  );
}

/** Auto top-up status and the two amounts it uses. Billing role only. */
export function useOrgAutoTopUpConfig(organizationId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.organizations.autoTopUp.getConfig.queryOptions(
      { organizationId: organizationId ?? '' },
      { enabled: enabled && organizationId != null }
    )
  );
}

export type OrgAuditLogEntry = RouterOutputs['organizations']['auditLogs']['list']['logs'][number];

type OrgAuditLogPage = RouterOutputs['organizations']['auditLogs']['list'];

/**
 * The audit log's cursor is `before` — a timestamp — and tRPC's
 * `infiniteQueryOptions` folds the page param into `cursor`, so this query
 * calls the procedure itself with its own key. Nothing else invalidates that
 * key: an audit entry is written by the server, not by a mutation this app
 * performs.
 */
export function useOrgAuditLogPage(organizationId: string | null, enabled: boolean) {
  // Declared rather than cast: the first page carries no `before`, and the
  // generic must still admit a timestamp for every page after it.
  const initialPageParam: string | undefined = undefined;
  const query = useInfiniteQuery(
    withInfiniteRetention({
      queryKey: ['organizations.auditLogs.list', organizationId] as const,
      enabled: enabled && organizationId != null,
      initialPageParam,
      queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
        trpcClient.organizations.auditLogs.list.query({
          organizationId: organizationId ?? '',
          ...(pageParam === undefined ? {} : { before: pageParam }),
        }),
      getNextPageParam: (lastPage: OrgAuditLogPage, pages: OrgAuditLogPage[]) =>
        lastPage.hasNext && hasRetentionBudget(pages.length)
          ? (lastPage.oldestTimestamp ?? undefined)
          : undefined,
      ...SETTLE_WHILE_OFFLINE,
    })
  );

  const pages = query.data?.pages;
  const entries = useMemo(() => (pages ?? []).flatMap(page => page.logs), [pages]);
  return { query, entries, hasMore: query.hasNextPage };
}
