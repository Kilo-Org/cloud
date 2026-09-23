/* eslint-disable max-lines -- one file for the review-list pagination builder and the mutation wiring suites */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildReviewFirstPageQueryOptions,
  buildReviewListQueryKey,
  buildReviewListQueryOptions,
  cancelReviewMutationFn,
  createManualReviewMutationFn,
  mergeReviewFirstPage,
  retriggerReviewMutationFn,
  REVIEW_PAGE_SIZE,
  useCancelReview,
  useCreateManualReview,
  useRetriggerReview,
} from './use-code-reviews';

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, vars: unknown) => void;
  onError?: (error: unknown) => void;
};

const cancelMutateMock = vi.fn();
const retriggerMutateMock = vi.fn();
const personalCreateMutateMock = vi.fn();
const orgCreateMutateMock = vi.fn();
const listForUserQueryMock = vi.fn();
const listForOrganizationQueryMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const cancelQueriesMock = vi.fn();
const getQueryDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const toastErrorMock = vi.fn();

let lastCapturedOptions: MutationOptions | null = null;

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutate: vi.fn() };
  },
  useQuery: () => ({ data: undefined }),
  useInfiniteQuery: () => ({ data: undefined }),
  useQueryClient: () => ({
    cancelQueries: cancelQueriesMock,
    getQueryData: getQueryDataMock,
    setQueryData: setQueryDataMock,
    invalidateQueries: invalidateQueriesMock,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    codeReviews: {
      listForUser: { queryKey: () => ['codeReviews', 'listForUser'] },
      listForOrganization: { queryKey: () => ['codeReviews', 'listForOrganization'] },
      get: { queryKey: () => ['codeReviews', 'get'] },
    },
  }),
  trpcClient: {
    codeReviews: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      listForUser: { query: (vars: unknown) => listForUserQueryMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      listForOrganization: { query: (vars: unknown) => listForOrganizationQueryMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      cancel: { mutate: (vars: unknown) => cancelMutateMock(vars) },
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      retrigger: { mutate: (vars: unknown) => retriggerMutateMock(vars) },
    },
    personalReviewAgent: {
      createManualReviewJob: {
        // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
        mutate: (vars: unknown) => personalCreateMutateMock(vars),
      },
    },
    organizations: {
      reviewAgent: {
        createManualReviewJob: {
          // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
          mutate: (vars: unknown) => orgCreateMutateMock(vars),
        },
      },
    },
  },
}));

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
}));

vi.mock('@kilocode/app-shared/code-review', () => ({
  hasInFlightReview: (reviews: { status: string }[]) =>
    reviews.some(review => review.status === 'running'),
  isInFlightReviewStatus: () => false,
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: (msg: string) => toastErrorMock(msg) },
}));

const CREATE_VARS = {
  platform: 'github',
  url: 'https://github.com/foo/bar/pull/1',
  modelSlug: 'claude-opus-4-7',
} as const;

function getOptions(hook: 'cancel' | 'retrigger' | 'create', scope = 'personal'): MutationOptions {
  lastCapturedOptions = null;
  if (hook === 'cancel') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useCancelReview(scope);
  } else if (hook === 'retrigger') {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useRetriggerReview(scope);
  } else {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useCreateManualReview(scope);
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lastCapturedOptions) {
    throw new Error(`mutation options for ${hook} were not captured`);
  }
  return lastCapturedOptions;
}

beforeEach(() => {
  lastCapturedOptions = null;
  cancelMutateMock.mockReset();
  retriggerMutateMock.mockReset();
  personalCreateMutateMock.mockReset();
  orgCreateMutateMock.mockReset();
  listForUserQueryMock.mockReset();
  listForOrganizationQueryMock.mockReset();
  invalidateQueriesMock.mockReset();
  cancelQueriesMock.mockReset();
  getQueryDataMock.mockReset();
  setQueryDataMock.mockReset();
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('cancelReviewMutationFn', () => {
  it('throws a typed error carrying the server error message on {success:false}', async () => {
    cancelMutateMock.mockResolvedValue({
      success: false,
      error: 'Review cannot be cancelled in its current state.',
    });

    await expect(cancelReviewMutationFn({ reviewId: 'r1' })).rejects.toThrow(
      'Review cannot be cancelled in its current state.'
    );
  });

  it('resolves with the full success payload so the mutation lifecycle continues normally', async () => {
    const successPayload = { success: true, review: { id: 'r1', status: 'cancelled' } };
    cancelMutateMock.mockResolvedValueOnce(successPayload);

    await expect(cancelReviewMutationFn({ reviewId: 'r1' })).resolves.toEqual(successPayload);
  });
});

describe('useCancelReview wiring', () => {
  it('toasts the thrown error message via onError and does NOT invalidate queries', async () => {
    cancelMutateMock.mockResolvedValue({
      success: false,
      error: 'Already completed',
    });
    const opts = getOptions('cancel');

    let thrown: unknown = null;
    try {
      await opts.mutationFn?.({ reviewId: 'r1' });
    } catch (error) {
      thrown = error;
      opts.onError?.(error);
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Already completed');
    expect(toastErrorMock).toHaveBeenCalledWith('Already completed');
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('invalidates the review list and detail on real success', () => {
    const opts = getOptions('cancel');
    opts.onSuccess?.({ success: true, review: { id: 'r1' } }, { reviewId: 'r1' });

    expect(invalidateQueriesMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('retriggerReviewMutationFn', () => {
  it('throws a typed error carrying the server error message on {success:false}', async () => {
    retriggerMutateMock.mockResolvedValueOnce({
      success: false,
      error: 'Repository not connected',
    });

    await expect(retriggerReviewMutationFn({ reviewId: 'r2' })).rejects.toThrow(
      'Repository not connected'
    );
  });

  it('resolves with the full success payload on success', async () => {
    const successPayload = { success: true, review: { id: 'r2', status: 'queued' } };
    retriggerMutateMock.mockResolvedValueOnce(successPayload);

    await expect(retriggerReviewMutationFn({ reviewId: 'r2' })).resolves.toEqual(successPayload);
  });
});

describe('useRetriggerReview wiring', () => {
  it('toasts the thrown error message via onError and does NOT invalidate queries', async () => {
    retriggerMutateMock.mockResolvedValueOnce({
      success: false,
      error: 'Provider rate limit hit',
    });
    const opts = getOptions('retrigger');

    try {
      await opts.mutationFn?.({ reviewId: 'r2' });
    } catch (error) {
      opts.onError?.(error);
    }

    expect(toastErrorMock).toHaveBeenCalledWith('Provider rate limit hit');
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('invalidates the review list and detail on real success', () => {
    const opts = getOptions('retrigger');
    opts.onSuccess?.({ success: true }, { reviewId: 'r2' });

    expect(invalidateQueriesMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe('createManualReviewMutationFn', () => {
  it('throws a typed error carrying the server error message on {success:false} (personal scope)', async () => {
    personalCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Invalid pull request URL',
    });

    await expect(createManualReviewMutationFn('personal', CREATE_VARS)).rejects.toThrow(
      'Invalid pull request URL'
    );
  });

  it('throws a typed error carrying the server error message on {success:false} (org scope)', async () => {
    orgCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Provider not connected for organization',
    });

    await expect(createManualReviewMutationFn('org_42', CREATE_VARS)).rejects.toThrow(
      'Provider not connected for organization'
    );
    expect(orgCreateMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_42' })
    );
  });

  it('resolves with the full success payload (including reviewId) so caller navigation works', async () => {
    const successPayload = { reviewId: 'rev_abc123', outputMode: 'provider' };
    personalCreateMutateMock.mockResolvedValue(successPayload);

    await expect(createManualReviewMutationFn('personal', CREATE_VARS)).resolves.toEqual(
      successPayload
    );
  });
});

describe('useCreateManualReview wiring', () => {
  it('toasts the thrown error message via onError and does NOT invalidate queries', async () => {
    const opts = getOptions('create', 'personal');
    personalCreateMutateMock.mockResolvedValue({
      success: false,
      error: 'Insufficient balance',
    });

    let thrown: unknown = null;
    try {
      await opts.mutationFn?.(CREATE_VARS);
    } catch (error) {
      thrown = error;
      opts.onError?.(error);
    }

    expect((thrown as Error).message).toBe('Insufficient balance');
    expect(toastErrorMock).toHaveBeenCalledWith('Insufficient balance');
    expect(invalidateQueriesMock).not.toHaveBeenCalled();
  });

  it('invalidates the list (no detail) on real success', () => {
    const opts = getOptions('create', 'personal');
    opts.onSuccess?.({ reviewId: 'rev_abc123', outputMode: 'provider' }, undefined);

    expect(invalidateQueriesMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// buildReviewListQueryOptions: offset pagination behind useReviewList
// ---------------------------------------------------------------------------

type ReviewPage = {
  success: boolean;
  reviews: { id: string; status: string }[];
  total?: number;
  hasMore?: boolean;
  error?: string;
};

type ReviewListOptions = ReturnType<typeof buildReviewListQueryOptions>;

function createReviewTrpcStub() {
  const stub = {
    codeReviews: {
      listForUser: { queryKey: () => ['codeReviews', 'listForUser'] },
      listForOrganization: {
        queryKey: (input: { organizationId: string }) => [
          'codeReviews',
          'listForOrganization',
          input,
        ],
      },
    },
  };
  return stub as never;
}

function makePage(count: number, hasMore = false, status = 'completed'): ReviewPage {
  return {
    success: true,
    reviews: Array.from({ length: count }, (_, index) => ({
      id: `review-${index}`,
      status,
    })),
    total: count,
    hasMore,
  };
}

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function callQueryFn(options: ReviewListOptions, pageParam: number): Promise<ReviewPage> {
  const queryFn = options.queryFn as unknown as (context: {
    pageParam: number;
  }) => Promise<ReviewPage>;
  return queryFn({ pageParam });
}

function readGetNextPageParam(
  options: ReviewListOptions
): (lastPage: ReviewPage, pages: ReviewPage[], lastPageParam: number) => number | undefined {
  return options.getNextPageParam as unknown as (
    lastPage: ReviewPage,
    pages: ReviewPage[],
    lastPageParam: number
  ) => number | undefined;
}

type ReviewProbeOptions = ReturnType<typeof buildReviewFirstPageQueryOptions>;

function readProbeRefetchInterval(
  options: ReviewProbeOptions
): (query: { state: { data?: ReviewPage } }) => number | false {
  return options.refetchInterval as unknown as (query: {
    state: { data?: ReviewPage };
  }) => number | false;
}

describe('buildReviewListQueryOptions (offset pagination)', () => {
  it('uses the listForUser key, starts at offset 0, and requests the first page', async () => {
    const options = buildReviewListQueryOptions(createReviewTrpcStub(), 'personal');
    listForUserQueryMock.mockResolvedValueOnce(makePage(1));

    expect(options.queryKey).toEqual(['codeReviews', 'listForUser']);
    expect(options.initialPageParam).toBe(0);
    expect(REVIEW_PAGE_SIZE).toBe(50);

    await callQueryFn(options, 0);

    expect(listForUserQueryMock).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it('uses the listForOrganization key and passes the requested offset through', async () => {
    const options = buildReviewListQueryOptions(createReviewTrpcStub(), 'org_42');
    listForOrganizationQueryMock.mockResolvedValueOnce(makePage(50));

    expect(options.queryKey).toEqual([
      'codeReviews',
      'listForOrganization',
      { organizationId: 'org_42' },
    ]);

    await callQueryFn(options, 50);

    expect(listForOrganizationQueryMock).toHaveBeenCalledWith({
      organizationId: 'org_42',
      limit: 50,
      offset: 50,
    });
  });

  it('advances the offset by the loaded row count while hasMore is true', () => {
    const options = buildReviewListQueryOptions(createReviewTrpcStub(), 'personal');
    const getNextPageParam = readGetNextPageParam(options);
    const page = makePage(50, true);

    expect(getNextPageParam(page, [page], 0)).toBe(50);
    expect(getNextPageParam(page, [page], 50)).toBe(100);
  });

  it('stops pagination when hasMore is false or the page failed', () => {
    const options = buildReviewListQueryOptions(createReviewTrpcStub(), 'personal');
    const getNextPageParam = readGetNextPageParam(options);

    expect(getNextPageParam(makePage(50, false), [], 0)).toBeUndefined();
    expect(getNextPageParam({ success: false, reviews: [], error: 'boom' }, [], 0)).toBeUndefined();
  });

  it('rejects a resolved failure page instead of treating it as an ordinary page', async () => {
    const options = buildReviewListQueryOptions(createReviewTrpcStub(), 'personal');
    listForUserQueryMock.mockResolvedValueOnce({ success: false, reviews: [], error: 'boom' });

    await expect(callQueryFn(options, 0)).rejects.toThrow('boom');
  });

  it('rejects a resolved failure next page and retries the same offset', async () => {
    const options = buildReviewListQueryOptions(createReviewTrpcStub(), 'personal');
    const getNextPageParam = readGetNextPageParam(options);

    const page1 = makePage(50, true);
    listForUserQueryMock.mockResolvedValueOnce(page1);
    const loaded = await callQueryFn(options, 0);
    expect(loaded.reviews).toHaveLength(50);

    // A resolved `{ success: false }` payload must reject like a thrown error
    // so `isFetchNextPageError` fires; the already-loaded rows stay held.
    listForUserQueryMock.mockResolvedValueOnce({ success: false, reviews: [], error: 'boom' });
    await expect(callQueryFn(options, 50)).rejects.toThrow('boom');
    expect(loaded.reviews).toHaveLength(50);
    expect(getNextPageParam(page1, [page1], 0)).toBe(50);

    // No page was appended, so retrying asks for the same offset again.
    const page2 = makePage(10, false);
    listForUserQueryMock.mockResolvedValueOnce(page2);
    await expect(callQueryFn(options, 50)).resolves.toEqual(page2);
    expect(listForUserQueryMock).toHaveBeenLastCalledWith({ limit: 50, offset: 50 });
  });

  it('keeps the loaded rows and retries the same offset after a failed next page', async () => {
    const options = buildReviewListQueryOptions(createReviewTrpcStub(), 'personal');
    const getNextPageParam = readGetNextPageParam(options);

    const page1 = makePage(50, true);
    listForUserQueryMock.mockResolvedValueOnce(page1);
    const loaded = await callQueryFn(options, 0);

    expect(loaded.reviews).toHaveLength(50);
    expect(getNextPageParam(page1, [page1], 0)).toBe(50);

    // The next page fails: the rows already loaded stay held and the retry
    // policy asks for the same offset again instead of dropping or skipping.
    listForUserQueryMock.mockRejectedValueOnce(new Error('network down'));
    await expect(callQueryFn(options, 50)).rejects.toThrow('network down');
    expect(loaded.reviews).toHaveLength(50);
    expect(getNextPageParam(page1, [page1], 0)).toBe(50);

    // Retrying the same offset resolves, and the terminal page stops paging.
    const page2 = makePage(10, false);
    listForUserQueryMock.mockResolvedValueOnce(page2);
    await callQueryFn(options, 50);

    expect(listForUserQueryMock).toHaveBeenLastCalledWith({ limit: 50, offset: 50 });
    expect(getNextPageParam(page2, [page1, page2], 50)).toBeUndefined();
  });

  it('bounds retention with maxPages and keeps the poll off the infinite query', () => {
    const options = buildReviewListQueryOptions(createReviewTrpcStub(), 'personal');

    expect(typeof options.maxPages).toBe('number');
    expect(options.maxPages).toBeGreaterThan(0);
    expect(options).not.toHaveProperty('refetchInterval');
  });
});

// ---------------------------------------------------------------------------
// buildReviewFirstPageQueryOptions: the off-the-infinite-query page-one poll
// ---------------------------------------------------------------------------

type ReviewListCacheParam = Parameters<typeof mergeReviewFirstPage>[0];
type ReviewListPageParam = Parameters<typeof mergeReviewFirstPage>[1];

function asListCache(pages: ReviewPage[], pageParams: number[]): NonNullable<ReviewListCacheParam> {
  return { pages, pageParams } as unknown as NonNullable<ReviewListCacheParam>;
}

function asReviewPage(page: ReviewPage): NonNullable<ReviewListPageParam> {
  return page as unknown as NonNullable<ReviewListPageParam>;
}

describe('buildReviewFirstPageQueryOptions (page-one probe)', () => {
  it('keys the probe under the list key so prefix invalidation still matches', () => {
    const trpc = createReviewTrpcStub();
    const listKey = buildReviewListQueryKey(trpc, 'personal');
    const options = buildReviewFirstPageQueryOptions(trpc, 'personal', true);

    expect(listKey).toEqual(['codeReviews', 'listForUser']);
    expect(options.queryKey.slice(0, listKey.length)).toEqual(listKey);
    expect(options.queryKey.length).toBeGreaterThan(listKey.length);
  });

  it('keys the org probe under the org list key', () => {
    const trpc = createReviewTrpcStub();
    const listKey = buildReviewListQueryKey(trpc, 'org_42');
    const options = buildReviewFirstPageQueryOptions(trpc, 'org_42', true);

    expect(listKey).toEqual(['codeReviews', 'listForOrganization', { organizationId: 'org_42' }]);
    expect(options.queryKey.slice(0, listKey.length)).toEqual(listKey);
    expect(options.queryKey.length).toBeGreaterThan(listKey.length);
  });

  it('fetches offset 0 only, with the caller enabled flag and a zero staleTime', async () => {
    const trpc = createReviewTrpcStub();
    const options = buildReviewFirstPageQueryOptions(trpc, 'personal', true);

    expect(options.staleTime).toBe(0);
    expect(options.enabled).toBe(true);
    expect(buildReviewFirstPageQueryOptions(trpc, 'personal', false).enabled).toBe(false);

    listForUserQueryMock.mockResolvedValueOnce(makePage(1));
    await options.queryFn();

    expect(listForUserQueryMock).toHaveBeenCalledTimes(1);
    expect(listForUserQueryMock).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it('polls page one every 5s only while that page holds a running review', () => {
    const options = buildReviewFirstPageQueryOptions(createReviewTrpcStub(), 'personal', true);
    const refetchInterval = readProbeRefetchInterval(options);

    expect(refetchInterval({ state: { data: makePage(50, true, 'running') } })).toBe(5000);
    expect(refetchInterval({ state: { data: makePage(50, false) } })).toBe(false);
    expect(
      refetchInterval({ state: { data: { success: false, reviews: [], error: 'boom' } } })
    ).toBe(false);
    expect(refetchInterval({ state: {} })).toBe(false);
  });
});

describe('mergeReviewFirstPage', () => {
  it('replaces page one and leaves pageParams and later pages untouched', () => {
    const oldFirst = makePage(2, true);
    const oldSecond = makePage(2, false);
    const fresh = makePage(3, true);
    const existing = asListCache([oldFirst, oldSecond], [0, 2]);

    const merged = mergeReviewFirstPage(existing, asReviewPage(fresh));

    expect(merged?.pages).toEqual([fresh, oldSecond]);
    expect(merged?.pageParams).toEqual([0, 2]);
  });

  it('returns the existing cache unchanged when it has no pages', () => {
    const existing = asListCache([], []);

    expect(mergeReviewFirstPage(existing, asReviewPage(makePage(1)))).toBe(existing);
  });

  it('leaves the list untouched once maxPages has evicted page one from the front', () => {
    // React Query appends forward pages with `addToEnd(..., maxPages)`, which
    // drops the oldest page, so past REVIEW_LIST_MAX_PAGES `pages[0]` and
    // `pageParams[0]` no longer hold offset 0. Writing the probe into that slot
    // would replace the oldest retained page with stale offset-0 rows and
    // desynchronise it from its page param.
    const retainedFirst = makePage(2, true, 'running');
    const retainedSecond = makePage(2, false);
    const existing = asListCache([retainedFirst, retainedSecond], [50, 100]);

    expect(mergeReviewFirstPage(existing, asReviewPage(makePage(3, true)))).toBe(existing);
  });

  it('leaves the list untouched when the probe page is not successful', () => {
    const existing = asListCache([makePage(1)], [0]);

    expect(
      mergeReviewFirstPage(existing, asReviewPage({ success: false, reviews: [], error: 'boom' }))
    ).toBe(existing);
  });

  it('no-ops on a missing cache', () => {
    expect(mergeReviewFirstPage(undefined, asReviewPage(makePage(1)))).toBeUndefined();
    expect(mergeReviewFirstPage(undefined, undefined)).toBeUndefined();
  });
});
