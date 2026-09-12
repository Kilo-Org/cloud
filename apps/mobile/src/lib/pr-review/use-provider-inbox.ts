// The provider-aware review inbox: one list, three providers.
//
// Each provider paginates on its own cursor and its own identity — GitHub
// through `githubPrReview.listInbox` exactly as before this slice, GitLab and
// Bitbucket through `providerReview.listInbox`. The cursors are never merged:
// `fetchNextPage` advances every source that still has a page, each with the
// cursor its own provider handed back, and a source that has run out simply
// stops contributing rows.
//
// A provider the user has not connected is never queried: each source stays
// disabled until its connection status says so.
//
// `mergeProviderInboxSources` is pure so the merge, the sort and the
// partial-failure rules are testable without mounting the hook.

import { type ProviderPrInboxItem } from '@kilocode/app-shared/provider-review';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';
import { useBitbucketReadiness, useGitLabStatus } from '@/lib/hooks/use-code-reviewer';
import { useOrganization } from '@/lib/organization-context';
import { classifyPrReviewQueryState } from '@/lib/pr-review/classify-pr-review-query-state';
import {
  githubPrRef,
  type ProviderPrPlatform,
  type ProviderPrRef,
  providerPrRefKey,
} from '@/lib/pr-review/provider-pr-ref';
import { usePrInbox } from '@/lib/pr-review/use-pr-inbox';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

// Same ceiling as the GitHub inbox: a pathological inbox cannot walk one
// provider's cursor forever.
const INBOX_MAX_PAGES = 20;

/** One inbox page as a provider read layer returns it. */
type ProviderInboxPage = { items: ProviderPrInboxItem[]; nextCursor: string | null };

const nextProviderCursor = (lastPage: ProviderInboxPage) => lastPage.nextCursor ?? undefined;

/** One inbox row, always carrying the ref the list navigates with. */
export type ProviderInboxRow = {
  readonly ref: ProviderPrRef;
  /** Collision-free across providers and GitLab instances (s1 key). */
  readonly key: string;
  readonly title: string;
  readonly isDraft: boolean;
  readonly updatedAt: string;
};

/** What one provider's infinite query contributes to the merged list. */
export type ProviderInboxSource = {
  readonly platform: ProviderPrPlatform;
  readonly enabled: boolean;
  readonly rows: readonly ProviderInboxRow[];
  readonly isPending: boolean;
  readonly hasLoadedPages: boolean;
  readonly error: unknown;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
};

export type MergedProviderInbox = {
  readonly items: readonly ProviderInboxRow[];
  readonly isPending: boolean;
  /** Set only when EVERY enabled provider failed its first page. */
  readonly firstPageErrorState: ReturnType<typeof classifyPrReviewQueryState> | null;
  /** A later page failed, or one provider failed while another loaded. */
  readonly laterPageError: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
};

function toRow(ref: ProviderPrRef, item: { title: string; isDraft: boolean; updatedAt: string }) {
  return {
    ref,
    key: providerPrRefKey(ref),
    title: item.title,
    isDraft: item.isDraft,
    updatedAt: item.updatedAt,
  };
}

type GitHubInboxItem = {
  owner: string;
  repo: string;
  number: number;
  title: string;
  isDraft: boolean;
  updatedAt: string;
};

export function toGitHubInboxRows(items: readonly GitHubInboxItem[]): ProviderInboxRow[] {
  return items.map(item => toRow(githubPrRef(item.owner, item.repo, item.number), item));
}

export function toProviderInboxRows(items: readonly ProviderPrInboxItem[]): ProviderInboxRow[] {
  return items.map(item =>
    toRow(item.ref, { title: item.title, isDraft: item.draft, updatedAt: item.updatedAt })
  );
}

function providerPageItems(pages: readonly ProviderInboxPage[] | undefined): ProviderPrInboxItem[] {
  return (pages ?? []).flatMap(page => page.items);
}

function updatedAtMs(row: ProviderInboxRow): number {
  const parsed = parseTimestamp(row.updatedAt).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Merge the per-provider results into one list.
 *
 * A first-page failure blanks the list ONLY when every enabled provider
 * failed — otherwise the providers that answered still render and the
 * failure degrades to the inline "couldn't load more" retry, because
 * hiding a working GitHub inbox behind a GitLab outage is worse than
 * showing a partial list.
 *
 * `isPending` is "no rows yet AND someone is still fetching", not "every
 * provider is pending": GitLab's REST inbox routinely answers before
 * GitHub's GraphQL one, and an AND would have declared the merged inbox
 * settled while GitHub still had every row, flashing the "No review
 * requests" empty state and then replacing it with rows. The `items`
 * guard is what keeps the rule from swinging the other way — once any
 * provider has contributed a row, a provider that only just became
 * enabled (its connection status resolves on its own clock) cannot send a
 * rendered list back to skeletons.
 */
export function mergeProviderInboxSources(
  sources: readonly ProviderInboxSource[]
): MergedProviderInbox {
  const active = sources.filter(source => source.enabled);
  const items = active
    .flatMap(source => source.rows)
    // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; flatMap already copies so nothing shared is mutated
    .sort((left, right) => updatedAtMs(right) - updatedAtMs(left));
  const failed = active.filter(source => source.error !== null && source.error !== undefined);
  const firstPageFailures = failed.filter(source => !source.hasLoadedPages);
  const allFailed = active.length > 0 && firstPageFailures.length === active.length;
  const firstError = firstPageFailures[0]?.error;
  return {
    items,
    isPending: items.length === 0 && active.some(source => source.isPending),
    firstPageErrorState: allFailed && firstError ? classifyPrReviewQueryState(firstError) : null,
    laterPageError: !allFailed && failed.length > 0,
    hasNextPage: active.some(source => source.hasNextPage),
    isFetchingNextPage: active.some(source => source.isFetchingNextPage),
  };
}

/**
 * What a "couldn't load more" retry must do for ONE provider.
 *
 * A provider that failed its FIRST page has no cursor to advance —
 * react-query reports `hasNextPage: false` while `data` is undefined — so
 * `fetchNextPage` would be a dead button there; it is retried with `refetch`,
 * which fetches page one. A provider that failed a LATER page advances its
 * own cursor. A provider that answered is left alone, so retrying one
 * provider's failure never re-fetches another's loaded pages.
 */
type InboxRetryAction = 'none' | 'refetch' | 'fetch-next-page';

export function inboxRetryAction(
  source: Pick<ProviderInboxSource, 'enabled' | 'error' | 'hasLoadedPages' | 'isFetchingNextPage'>
): InboxRetryAction {
  if (!source.enabled || source.isFetchingNextPage) {
    return 'none';
  }
  if (source.error === null || source.error === undefined) {
    return 'none';
  }
  return source.hasLoadedPages ? 'fetch-next-page' : 'refetch';
}

/** The two calls `inboxRetryAction` chooses between, for one query. */
type RetryableQuery = {
  refetch: () => void;
  fetchNextPage: () => void;
  isRefetchError: boolean;
};

function runInboxRetry(source: ProviderInboxSource, query: RetryableQuery): void {
  const action = inboxRetryAction(source);
  // A failed refresh has cached pages, but must reload them rather than advance a cursor.
  if (action === 'refetch' || (action === 'fetch-next-page' && query.isRefetchError)) {
    query.refetch();
  } else if (action === 'fetch-next-page') {
    query.fetchNextPage();
  }
}

type Trpc = ReturnType<typeof useTRPC>;

/** GitLab's inbox input: the personal scope sends no organization. */
export function buildGitLabInboxQueryOptions(
  trpc: Trpc,
  args: { enabled: boolean; organizationId: string | null }
) {
  return trpc.providerReview.listInbox.infiniteQueryOptions(
    { platform: 'gitlab', ...(args.organizationId ? { organizationId: args.organizationId } : {}) },
    {
      enabled: args.enabled,
      staleTime: 30_000,
      getNextPageParam: nextProviderCursor,
      maxPages: INBOX_MAX_PAGES,
    }
  );
}

/** Bitbucket Cloud is organization-only, so no organization means no query. */
export function buildBitbucketInboxQueryOptions(
  trpc: Trpc,
  args: { enabled: boolean; organizationId: string | null }
) {
  return trpc.providerReview.listInbox.infiniteQueryOptions(
    { platform: 'bitbucket', organizationId: args.organizationId ?? '' },
    {
      enabled: args.enabled && args.organizationId !== null,
      staleTime: 30_000,
      getNextPageParam: nextProviderCursor,
      maxPages: INBOX_MAX_PAGES,
    }
  );
}

/**
 * The merged inbox. Each source is gated on its connection status so an
 * unconnected provider is never called.
 */
export function useProviderInbox(enabled: boolean) {
  const trpc = useTRPC();
  const { organizationId } = useOrganization();
  const scope = organizationId ?? PERSONAL_SCOPE;
  const gitlabStatus = useGitLabStatus(scope);
  const bitbucketReadiness = useBitbucketReadiness(scope);
  // Like the GitHub detail gate, inbox reads require the user's authorization,
  // not a personal or organization GitHub App installation.
  const githubAuthorization = useQuery({
    ...trpc.githubApps.getUserAuthorization.queryOptions(),
    enabled,
  });

  const githubEnabled = enabled && githubAuthorization.data?.connected === true;
  const github = usePrInbox(githubEnabled);
  const gitlabEnabled = enabled && gitlabStatus.data?.connected === true;
  const bitbucketEnabled = enabled && bitbucketReadiness.data?.connected === true;
  const gitlab = useInfiniteQuery(
    buildGitLabInboxQueryOptions(trpc, { enabled: gitlabEnabled, organizationId })
  );
  const bitbucket = useInfiniteQuery(
    buildBitbucketInboxQueryOptions(trpc, { enabled: bitbucketEnabled, organizationId })
  );

  const githubRows = useMemo(() => toGitHubInboxRows(github.items), [github.items]);
  const gitlabPages = gitlab.data?.pages;
  const gitlabRows = useMemo(
    () => toProviderInboxRows(providerPageItems(gitlabPages)),
    [gitlabPages]
  );
  const bitbucketPages = bitbucket.data?.pages;
  const bitbucketRows = useMemo(
    () => toProviderInboxRows(providerPageItems(bitbucketPages)),
    [bitbucketPages]
  );

  const githubSource: ProviderInboxSource = {
    platform: 'github',
    // Status loading/failure participates in the existing inbox states, but
    // only a connected source can expose cached pages or issue inbox reads.
    enabled:
      enabled && (githubEnabled || githubAuthorization.isPending || githubAuthorization.isError),
    rows: githubEnabled ? githubRows : [],
    isPending: githubEnabled ? github.query.isPending : githubAuthorization.isPending,
    hasLoadedPages: githubEnabled && (github.query.data?.pages.length ?? 0) > 0,
    error: githubEnabled ? github.query.error : githubAuthorization.error,
    hasNextPage: githubEnabled && github.query.hasNextPage,
    isFetchingNextPage: githubEnabled && github.query.isFetchingNextPage,
  };
  const gitlabSource: ProviderInboxSource = {
    platform: 'gitlab',
    enabled: gitlabEnabled,
    rows: gitlabRows,
    isPending: gitlab.isPending,
    hasLoadedPages: (gitlabPages?.length ?? 0) > 0,
    error: gitlab.error,
    hasNextPage: gitlab.hasNextPage,
    isFetchingNextPage: gitlab.isFetchingNextPage,
  };
  const bitbucketSource: ProviderInboxSource = {
    platform: 'bitbucket',
    enabled: bitbucketEnabled,
    rows: bitbucketRows,
    isPending: bitbucket.isPending,
    hasLoadedPages: (bitbucketPages?.length ?? 0) > 0,
    error: bitbucket.error,
    hasNextPage: bitbucket.hasNextPage,
    isFetchingNextPage: bitbucket.isFetchingNextPage,
  };
  const merged = mergeProviderInboxSources([githubSource, gitlabSource, bitbucketSource]);

  // Every source advances on ITS OWN cursor; nothing is shared or merged.
  const fetchNextPage = useCallback(() => {
    if (githubEnabled && github.query.hasNextPage && !github.query.isFetchingNextPage) {
      void github.query.fetchNextPage();
    }
    if (gitlabEnabled && gitlab.hasNextPage && !gitlab.isFetchingNextPage) {
      void gitlab.fetchNextPage();
    }
    if (bitbucketEnabled && bitbucket.hasNextPage && !bitbucket.isFetchingNextPage) {
      void bitbucket.fetchNextPage();
    }
  }, [github.query, gitlab, bitbucket, githubEnabled, gitlabEnabled, bitbucketEnabled]);

  const refetch = useCallback(() => {
    if (githubEnabled) {
      void github.query.refetch();
    } else if (enabled) {
      void githubAuthorization.refetch();
    }
    if (gitlabEnabled) {
      void gitlab.refetch();
    }
    if (bitbucketEnabled) {
      void bitbucket.refetch();
    }
  }, [
    github.query,
    githubAuthorization,
    gitlab,
    bitbucket,
    enabled,
    githubEnabled,
    gitlabEnabled,
    bitbucketEnabled,
  ]);

  // The "couldn't load more" retry: it must load the page that FAILED, not
  // re-run the whole inbox. Each failed provider gets exactly the call its
  // own state needs; every healthy provider keeps its loaded pages.
  // Not memoized on purpose: it reads the per-render source objects above, so
  // a memo keyed on the query results would fire the previous render's
  // decision whenever only an `enabled` flag moved.
  const retryFailedPages = () => {
    if (!githubEnabled && enabled && githubAuthorization.isError) {
      void githubAuthorization.refetch();
    } else {
      runInboxRetry(githubSource, github.query);
    }
    runInboxRetry(gitlabSource, gitlab);
    runInboxRetry(bitbucketSource, bitbucket);
  };

  return {
    ...merged,
    // Revoked authorization needs the connect flow, not an inbox-page retry.
    githubNeedsReconnect: enabled && githubAuthorization.data?.revoked === true,
    isFetching:
      (enabled && githubAuthorization.isFetching) ||
      (githubEnabled && github.query.isFetching) ||
      (gitlabEnabled && gitlab.isFetching) ||
      (bitbucketEnabled && bitbucket.isFetching),
    fetchNextPage,
    retryFailedPages,
    refetch,
  };
}
