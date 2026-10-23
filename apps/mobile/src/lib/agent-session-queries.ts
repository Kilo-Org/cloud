/**
 * Infinite-query options for the session lists.
 *
 * Kept apart from `use-agent-sessions.ts` so the options are executable-tested
 * without mounting the hook (which pulls in react-native and the tRPC client),
 * and so both newest-first session lists share one paging contract:
 * `sessionNextPageParam` stops the cursor chain at `SESSION_HISTORY_MAX_PAGES`
 * instead of letting React Query's `maxPages` trim drop page one — the newest
 * page, which the user scrolls back to.
 */

import { keepPreviousData } from '@tanstack/react-query';

import {
  buildAgentSessionListInput,
  buildAgentSessionSearchInput,
} from '@/lib/agent-session-input';
import { SESSION_HISTORY_MAX_PAGES, sessionNextPageParam } from '@/lib/agent-session-pages';
import { type AgentSessionSortBy } from '@/lib/agent-session-sort';
import { withInfiniteRetention } from '@/lib/query/infinite-retention';
import { type useTRPC } from '@/lib/trpc';

type TrpcClient = ReturnType<typeof useTRPC>;

export type UseAgentSessionsOptions = {
  createdOnPlatform?: string | string[];
  gitUrl?: string | string[];
  organizationId?: string | null;
  enabled?: boolean;
  /**
   * Field to order by. Defaults to `updated_at` so callers that don't
   * care (e.g. Home's session surface) keep the legacy behavior bit-for-bit.
   */
  sortBy?: AgentSessionSortBy;
  /**
   * Foreground reconcile ownership for the stored-sessions query.
   *
   * The hook owns the OS app-foreground refresh: on the shared
   * `useAppLifecycle` false -> true edge it reconciles page one (resets the
   * cached pages and refetches from `initialPageParam`) instead of letting
   * React Query's native window-focus refetch fan out over every retained
   * page. That edge is registered unless the caller passes `false`; the native
   * query option stays off by default for the same reason.
   *
   * The Agents list passes `false`: its screen drives app-foreground refresh
   * through its own AppState callback that runs the wrapped `refetch`, so the
   * hook must not reconcile a second time.
   */
  refetchOnWindowFocus?: boolean;
};

export type UseAgentSessionSearchOptions = UseAgentSessionsOptions & {
  searchQuery: string;
};

/**
 * Build the stored-sessions infinite-query options shared by every stored
 * refetch path on the Agents screen (focus return, pull-to-refresh, retry,
 * departure trigger, backfill).
 */
export function buildStoredSessionsQueryOptions(
  trpc: TrpcClient,
  options?: UseAgentSessionsOptions
) {
  const base = trpc.cliSessionsV2.list.infiniteQueryOptions(
    buildAgentSessionListInput(options ?? {}),
    {
      staleTime: 30_000,
      enabled: options?.enabled,
      getNextPageParam: sessionNextPageParam,
      // The hook owns the OS-foreground refresh through its `useAppLifecycle`
      // edge (see `storedReconcile`), so the native window-focus refetch stays
      // off by default: React Query's native path re-requests every retained
      // page, which is exactly the burst the page-one reconcile replaces.
      refetchOnWindowFocus: options?.refetchOnWindowFocus ?? false,
    }
  );
  return withInfiniteRetention(base, SESSION_HISTORY_MAX_PAGES);
}

/**
 * Build the server-side session-search infinite-query options. The search list
 * is newest-first like the stored history, so it uses the same guarded cursor:
 * page one stays cached when the cursor chain reaches the retention bound.
 */
export function buildAgentSessionSearchQueryOptions(
  trpc: TrpcClient,
  options: UseAgentSessionSearchOptions
) {
  return withInfiniteRetention(
    trpc.cliSessionsV2.search.infiniteQueryOptions(buildAgentSessionSearchInput(options), {
      staleTime: 30_000,
      enabled: (options.enabled ?? true) && options.searchQuery.length > 0,
      placeholderData: keepPreviousData,
      getNextPageParam: sessionNextPageParam,
    }),
    SESSION_HISTORY_MAX_PAGES
  );
}
