import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  buildOrgCreditTransactionsPageQueryOptions,
  buildOrgInvoicesPageQueryOptions,
} from '@/lib/hooks/use-organization-queries';
import { INFINITE_QUERY_MAX_PAGES } from '@/lib/query/infinite-retention';

// The hook module imports its context providers (and the real tRPC client)
// transitively; the options builders are pure, so only the module-load chain
// needs these mocks. No hook is mounted.
vi.mock('@/lib/trpc', () => ({
  useTRPC: vi.fn(),
}));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: vi.fn() }));
vi.mock('@/lib/organization-context', () => ({ useOrganization: vi.fn() }));

type Page = { hasMore: boolean; nextCursor: string | null };

const echoInfiniteQueryOptions = (input: unknown, options: object) => ({ ...options, input });

type EchoedOptions = {
  maxPages: number;
  enabled: boolean;
  input: { organizationId: string; period?: string };
  getNextPageParam: (lastPage: Page, pages: Page[]) => string | undefined;
};

/**
 * Fake tRPC router whose `infiniteQueryOptions` echoes the options it was
 * given alongside the input, so a builder's retention bound and the exact
 * input each procedure receives can be asserted without mounting the hook.
 */
function createTrpcStub() {
  const stub = {
    organizations: {
      creditTransactionsPage: { infiniteQueryOptions: echoInfiniteQueryOptions },
      invoicesPage: { infiniteQueryOptions: echoInfiniteQueryOptions },
    },
  };
  return stub as never;
}

function readOptions(options: object): EchoedOptions {
  return options as unknown as EchoedOptions;
}

describe('buildOrgCreditTransactionsPageQueryOptions', () => {
  it('applies the shared retention bound', () => {
    const options = readOptions(
      buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')
    );

    expect(options.maxPages).toBe(INFINITE_QUERY_MAX_PAGES);
  });

  it('keeps the enabled passthrough (disabled for a null organizationId)', () => {
    expect(
      readOptions(buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')).enabled
    ).toBe(true);
    expect(
      readOptions(buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), null)).enabled
    ).toBe(false);
  });

  it('passes the organizationId through to the procedure input', () => {
    expect(
      readOptions(buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')).input
    ).toEqual({ organizationId: 'org-1' });
    expect(
      readOptions(buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), null)).input
    ).toEqual({ organizationId: '' });
  });

  it('returns the next cursor while hasMore, and stops on the last page', () => {
    const { getNextPageParam } = readOptions(
      buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')
    );

    expect(getNextPageParam({ hasMore: true, nextCursor: 'cursor-1' }, [])).toBe('cursor-1');
    expect(getNextPageParam({ hasMore: false, nextCursor: 'cursor-2' }, [])).toBeUndefined();
    expect(getNextPageParam({ hasMore: true, nextCursor: null }, [])).toBeUndefined();
  });

  it('stops forward paging at the retention bound instead of evicting the newest page', () => {
    const { getNextPageParam } = readOptions(
      buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')
    );
    const page: Page = { hasMore: true, nextCursor: 'cursor-1' };
    const atBound = Array.from({ length: INFINITE_QUERY_MAX_PAGES }, () => page);
    const belowBound = atBound.slice(0, INFINITE_QUERY_MAX_PAGES - 1);

    // The list is newest-first, so React Query's `maxPages` trim on a forward
    // fetch (`addToEnd` slices index 0) would drop page one — the newest page.
    // Refusing the next page keeps every loaded page, newest rows included.
    expect(getNextPageParam(page, atBound)).toBeUndefined();
    expect(getNextPageParam(page, belowBound)).toBe('cursor-1');
  });
});

describe('buildOrgInvoicesPageQueryOptions', () => {
  it('applies the shared retention bound', () => {
    const options = readOptions(buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1'));

    expect(options.maxPages).toBe(INFINITE_QUERY_MAX_PAGES);
  });

  it('keeps the enabled passthrough (disabled for a null organizationId)', () => {
    expect(readOptions(buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1')).enabled).toBe(
      true
    );
    expect(readOptions(buildOrgInvoicesPageQueryOptions(createTrpcStub(), null)).enabled).toBe(
      false
    );
  });

  it("keeps the fixed period: 'year' input and the organizationId", () => {
    expect(readOptions(buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1')).input).toEqual({
      organizationId: 'org-1',
      period: 'year',
    });
  });

  it('returns the next cursor while hasMore, and stops on the last page', () => {
    const { getNextPageParam } = readOptions(
      buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1')
    );

    expect(getNextPageParam({ hasMore: true, nextCursor: 'cursor-1' }, [])).toBe('cursor-1');
    expect(getNextPageParam({ hasMore: false, nextCursor: 'cursor-2' }, [])).toBeUndefined();
    expect(getNextPageParam({ hasMore: true, nextCursor: null }, [])).toBeUndefined();
  });

  it('stops forward paging at the retention bound instead of evicting the newest page', () => {
    const { getNextPageParam } = readOptions(
      buildOrgInvoicesPageQueryOptions(createTrpcStub(), 'org-1')
    );
    const page: Page = { hasMore: true, nextCursor: 'cursor-1' };
    const atBound = Array.from({ length: INFINITE_QUERY_MAX_PAGES }, () => page);
    const belowBound = atBound.slice(0, INFINITE_QUERY_MAX_PAGES - 1);

    // Stripe lists invoices newest-first, so `maxPages` would trim page one (the
    // newest page) on a forward fetch. Refusing the next page at the bound keeps
    // the newest invoices retained.
    expect(getNextPageParam(page, atBound)).toBeUndefined();
    expect(getNextPageParam(page, belowBound)).toBe('cursor-1');
  });
});

/**
 * Drive the builder's real `getNextPageParam` and `maxPages` through React
 * Query's infinite-query behavior, so the front-trim hazard the finding
 * describes is reproduced against the cache rather than asserted on the
 * callback alone: without the refusal bound the sixth forward fetch runs
 * `addToEnd(pages, page, 5)`, which drops index 0 — page one, the newest page.
 */
describe('org infinite-list retention', () => {
  type RetentionPage = {
    entries: { id: string }[];
    hasMore: boolean;
    nextCursor: string | null;
  };

  type RetentionGetNextPageParam = (
    lastPage: RetentionPage,
    pages: RetentionPage[]
  ) => string | undefined;

  async function collectPageIds(
    getNextPageParam: RetentionGetNextPageParam,
    forwards: number
  ): Promise<{ ids: string[]; fetched: number; hasNextPage: boolean }> {
    const queryClient = new QueryClient();
    let fetched = 0;
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: ['org-list-retention-test'],
      initialPageParam: '0',
      // eslint-disable-next-line require-await -- the recipe pins an async queryFn; the body needs no await.
      queryFn: async ({ pageParam }: { pageParam: string }) => {
        const index = Number(pageParam);
        fetched += 1;
        return {
          entries: [{ id: `entry-${index}` }],
          hasMore: true,
          nextCursor: String(index + 1),
        };
      },
      getNextPageParam,
      maxPages: INFINITE_QUERY_MAX_PAGES,
      staleTime: Infinity,
      retry: false,
    });
    // eslint-disable-next-line no-empty-function -- a real listener is required to activate the observer; the body is intentionally empty.
    const unsubscribe = observer.subscribe(() => {});

    await observer.refetch();
    for (let loaded = 1; loaded <= forwards; loaded += 1) {
      // eslint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's result.
      await observer.fetchNextPage();
    }

    const result = observer.getCurrentResult();
    const ids = (result.data?.pages ?? []).flatMap(page => page.entries.map(entry => entry.id));
    unsubscribe();
    return { ids, fetched, hasNextPage: result.hasNextPage };
  }

  it('keeps the newest page instead of letting maxPages front-trim it', async () => {
    const { getNextPageParam } = readOptions(
      buildOrgCreditTransactionsPageQueryOptions(createTrpcStub(), 'org-1')
    ) as unknown as { getNextPageParam: RetentionGetNextPageParam };

    const { ids, fetched, hasNextPage } = await collectPageIds(
      getNextPageParam,
      INFINITE_QUERY_MAX_PAGES + 2
    );

    // Page one (`entry-0`, the newest entry) is still at the front, every page
    // that was loaded is retained, and no sixth request was issued.
    expect(ids).toEqual(['entry-0', 'entry-1', 'entry-2', 'entry-3', 'entry-4']);
    expect(fetched).toBe(INFINITE_QUERY_MAX_PAGES);
    expect(hasNextPage).toBe(false);
  });
});
