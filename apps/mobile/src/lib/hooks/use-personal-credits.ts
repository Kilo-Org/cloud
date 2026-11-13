import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type CreditPurchaseEntry } from '@/lib/credits/credit-history';
import { hasRetentionBudget, withInfiniteRetention } from '@/lib/query/infinite-retention';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

type RouterOutputs = inferRouterOutputs<MobileRouter>;

/** One personal invoice, the same shape the organization invoice screen reads. */
export type PersonalInvoice = RouterOutputs['user']['invoicesPage']['entries'][number];

/**
 * The balance, its blocks, and the deductions the personal credit history
 * shows. The profile credits card reads the same key, so both surfaces share
 * one cache entry and the history opens on what the card already loaded.
 */
export function usePersonalCreditBlocks(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.user.getCreditBlocks.queryOptions({}),
    enabled,
    ...SETTLE_WHILE_OFFLINE,
  });
}

/**
 * Build the purchase-history infinite-query options. Kept as a pure builder so
 * the offset paging and the retention bound are testable without mounting the
 * hook.
 *
 * The endpoint pages by offset (`nextCursor` is the next offset), which is the
 * `cursor` input field tRPC's infinite helper injects, so page one starts at 0
 * and each next page passes the offset the server returned.
 */
function buildCreditPurchaseHistoryQueryOptions(trpc: ReturnType<typeof useTRPC>) {
  return withInfiniteRetention(
    trpc.user.getCreditPurchaseHistory.infiniteQueryOptions(
      {},
      {
        getNextPageParam: (lastPage, pages) =>
          lastPage.nextCursor != null && hasRetentionBudget(pages.length)
            ? lastPage.nextCursor
            : undefined,
        ...SETTLE_WHILE_OFFLINE,
      }
    )
  );
}

/** Cursor-paginated personal credit purchases, flattened across loaded pages. */
export function useCreditPurchaseHistory(enabled: boolean) {
  const trpc = useTRPC();
  const query = useInfiniteQuery({
    ...buildCreditPurchaseHistoryQueryOptions(trpc),
    enabled,
  });

  const pages = query.data?.pages;
  const entries = useMemo<CreditPurchaseEntry[]>(
    () => (pages ?? []).flatMap(page => page.entries),
    [pages]
  );

  return { query, entries, hasMore: query.hasNextPage };
}

/**
 * Build the personal invoice infinite-query options, mirroring the
 * organization builder: the same fixed one-year period and the same cursor
 * passthrough, so one screen renders either scope.
 */
function buildPersonalInvoicesQueryOptions(trpc: ReturnType<typeof useTRPC>) {
  return withInfiniteRetention(
    trpc.user.invoicesPage.infiniteQueryOptions(
      { period: 'year' },
      {
        getNextPageParam: (lastPage, pages) =>
          lastPage.hasMore && hasRetentionBudget(pages.length)
            ? (lastPage.nextCursor ?? undefined)
            : undefined,
        // A paused first page leaves the skeleton rows with no exit.
        ...SETTLE_WHILE_OFFLINE,
      }
    )
  );
}

/** Cursor-paginated invoices for the person's own Stripe customer. */
export function usePersonalInvoicesPage() {
  const trpc = useTRPC();
  const query = useInfiniteQuery(buildPersonalInvoicesQueryOptions(trpc));

  const pages = query.data?.pages;
  const entries = useMemo<PersonalInvoice[]>(
    () => (pages ?? []).flatMap(page => page.entries),
    [pages]
  );

  return { query, entries, hasMore: query.hasNextPage };
}
