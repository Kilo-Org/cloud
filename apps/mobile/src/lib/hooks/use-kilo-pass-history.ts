import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { type KiloPassBillingEntry, type KiloPassCreditEntry } from '@/lib/kilo-pass/management';
import { hasRetentionBudget, withInfiniteRetention } from '@/lib/query/infinite-retention';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

/**
 * The two Kilo Pass ledger lists are cursor-paged and both are rendered inside
 * one scrolling screen, so each keeps a bounded number of pages and hands the
 * screen one flat list.
 *
 * The first page passes no cursor — the provider lists every invoice from the
 * newest — so `initialPageParam` is null and each next page starts after the
 * last entry the server returned.
 */
function buildKiloPassBillingHistoryQueryOptions(trpc: ReturnType<typeof useTRPC>) {
  return withInfiniteRetention(
    trpc.kiloPass.getBillingHistory.infiniteQueryOptions(
      { limit: 10 },
      {
        getNextPageParam: (lastPage, pages) =>
          lastPage.hasMore && hasRetentionBudget(pages.length)
            ? (lastPage.cursor ?? undefined)
            : undefined,
        ...SETTLE_WHILE_OFFLINE,
      }
    )
  );
}

function buildKiloPassCreditHistoryQueryOptions(trpc: ReturnType<typeof useTRPC>) {
  return withInfiniteRetention(
    trpc.kiloPass.getCreditHistory.infiniteQueryOptions(
      {},
      {
        getNextPageParam: (lastPage, pages) =>
          lastPage.hasMore && hasRetentionBudget(pages.length)
            ? (lastPage.cursor ?? undefined)
            : undefined,
        ...SETTLE_WHILE_OFFLINE,
      }
    )
  );
}

export function useKiloPassBillingHistory(enabled: boolean) {
  const trpc = useTRPC();
  const query = useInfiniteQuery({
    ...buildKiloPassBillingHistoryQueryOptions(trpc),
    enabled,
  });

  const pages = query.data?.pages;
  const entries = useMemo<KiloPassBillingEntry[]>(
    () => (pages ?? []).flatMap(page => page.entries),
    [pages]
  );

  return { query, entries, hasMore: query.hasNextPage };
}

export function useKiloPassCreditHistory(enabled: boolean) {
  const trpc = useTRPC();
  const query = useInfiniteQuery({
    ...buildKiloPassCreditHistoryQueryOptions(trpc),
    enabled,
  });

  const pages = query.data?.pages;
  const entries = useMemo<KiloPassCreditEntry[]>(
    () => (pages ?? []).flatMap(page => page.entries),
    [pages]
  );

  return { query, entries, hasMore: query.hasNextPage };
}
