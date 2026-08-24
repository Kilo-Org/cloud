/* eslint-disable max-lines -- the debounced delta sender and mutation payload suites share one mock harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as TanStackQuery from '@tanstack/react-query';

import { PERSONAL_SCOPE } from '@/lib/code-reviewer-config';

import {
  REPO_SELECTION_DEBOUNCE_MS,
  resetRepoSelectionSendersForTests,
  useRepoSelectionToggle,
} from './use-code-reviewer-repo-selection';

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onError?: (error: unknown, vars?: unknown) => void;
  onSettled?: () => void;
  onSuccess?: (data: unknown, vars?: unknown) => void;
};

const personalPatchMutateMock = vi.fn();
const orgPatchMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const toastErrorMock = vi.fn();
const mutateMock = vi.fn();

let lastCapturedOptions: MutationOptions | null = null;
let reviewConfigCache: { selectedRepositoryIds: (number | string)[] } | undefined = undefined;

const setQueryDataMock = vi.fn((_key: unknown, updater: unknown) => {
  if (typeof updater === 'function') {
    reviewConfigCache = (updater as (old: typeof reviewConfigCache) => typeof reviewConfigCache)(
      reviewConfigCache
    );
  }
});

// The refetch-sync subscription callback captured by the mocked query cache,
// so a test can simulate a refetch response landing.
const subscriptionState = vi.hoisted(() => ({
  capturedSubscribe: null as ((event: unknown) => void) | null,
}));

vi.mock('react', () => ({
  // Real useEffect needs a rendering context; run the effect synchronously so
  // the refetch-sync subscription is set up when the hook is called as a plain
  // function (same convention as chat-composer.test.ts).
  useEffect: vi.fn((fn: () => void) => {
    fn();
  }),
}));

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual<typeof TanStackQuery>('@tanstack/react-query');
  return {
    ...actual,
    useMutation: (opts: MutationOptions) => {
      lastCapturedOptions = opts;
      return { mutate: mutateMock };
    },
    useQueryClient: () => ({
      getQueryData: () => reviewConfigCache,
      setQueryData: setQueryDataMock,
      invalidateQueries: invalidateQueriesMock,
      getQueryCache: () => ({
        // eslint-disable-next-line promise/prefer-await-to-callbacks -- a cache subscription is callback-based by design
        subscribe: (cb: (event: unknown) => void) => {
          subscriptionState.capturedSubscribe = cb;
          return () => {
            subscriptionState.capturedSubscribe = null;
          };
        },
      }),
    }),
  };
});

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    personalReviewAgent: {
      getReviewConfig: { queryKey: () => ['personalReviewAgent', 'getReviewConfig'] },
    },
    organizations: {
      reviewAgent: {
        getReviewConfig: { queryKey: () => ['organizations', 'reviewAgent', 'getReviewConfig'] },
      },
    },
  }),
  trpcClient: {
    personalReviewAgent: {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      patchReviewConfig: { mutate: (vars: unknown) => personalPatchMutateMock(vars) },
    },
    organizations: {
      reviewAgent: {
        // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
        patchReviewConfig: { mutate: (vars: unknown) => orgPatchMutateMock(vars) },
      },
    },
  },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: (msg: string) => toastErrorMock(msg) },
}));

// use-code-reviewer.ts re-exports from use-reviewer-permission, which imports
// useRouter from expo-router. Loading the real module in node blows up on the
// expo-router source map, so stub the surface the re-export reaches.
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

function getToggleRepo(
  scope: string,
  platform: 'github' | 'gitlab' | 'bitbucket'
): { toggleRepo: (id: number | string) => void; deltaOptions: MutationOptions } {
  lastCapturedOptions = null;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const toggleRepo = useRepoSelectionToggle(scope, platform);
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!lastCapturedOptions) {
    throw new Error('mutation options for useSaveReviewConfigDelta were not captured');
  }
  return { toggleRepo, deltaOptions: lastCapturedOptions };
}

function seedReviewConfigCache(ids: (number | string)[]) {
  reviewConfigCache = { selectedRepositoryIds: ids };
}

// Simulates a refetch response landing: the response first overwrites the
// cache, then the query cache notifies subscribers (the refetch-sync hook).
function fireRefetch(scope: string, selectedRepositoryIds: (number | string)[]) {
  reviewConfigCache = { selectedRepositoryIds };
  const queryKey =
    scope === PERSONAL_SCOPE
      ? ['personalReviewAgent', 'getReviewConfig']
      : ['organizations', 'reviewAgent', 'getReviewConfig'];
  if (!subscriptionState.capturedSubscribe) {
    throw new Error('refetch subscription was not captured');
  }
  subscriptionState.capturedSubscribe({
    type: 'updated',
    action: { type: 'success', data: { selectedRepositoryIds } },
    query: { queryHash: TanStackQuery.hashKey(queryKey) },
  });
}

beforeEach(() => {
  lastCapturedOptions = null;
  reviewConfigCache = undefined;
  subscriptionState.capturedSubscribe = null;
  personalPatchMutateMock.mockReset();
  orgPatchMutateMock.mockReset();
  invalidateQueriesMock.mockReset();
  toastErrorMock.mockReset();
  mutateMock.mockReset();
  setQueryDataMock.mockClear();
  personalPatchMutateMock.mockResolvedValue({ success: true, webhookSync: null });
  orgPatchMutateMock.mockResolvedValue({ success: true, webhookSync: null });
});

afterEach(() => {
  resetRepoSelectionSendersForTests();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useRepoSelectionToggle debounced delta sender', () => {
  it('collapses five rapid toggles into one mutation with the correct net delta', () => {
    vi.useFakeTimers();
    seedReviewConfigCache([1, 2]);
    const { toggleRepo } = getToggleRepo(PERSONAL_SCOPE, 'github');

    toggleRepo(3);
    toggleRepo(4);
    toggleRepo(5);
    toggleRepo(6);
    toggleRepo(7);

    expect(mutateMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock.mock.calls[0]?.[0]).toEqual({
      add: [3, 4, 5, 6, 7],
      remove: [],
      optimisticSelection: [1, 2, 3, 4, 5, 6, 7],
    });
  });

  it('rolls back the optimistic cache to the server state when the save fails', () => {
    vi.useFakeTimers();
    seedReviewConfigCache([1, 2]);
    const { toggleRepo, deltaOptions } = getToggleRepo(PERSONAL_SCOPE, 'github');

    toggleRepo(3);
    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);

    expect(mutateMock).toHaveBeenCalledTimes(1);
    const vars = mutateMock.mock.calls[0]?.[0] as { optimisticSelection: unknown };
    deltaOptions.onError?.(new Error('Network unreachable'), vars);

    expect(reviewConfigCache?.selectedRepositoryIds).toEqual([1, 2]);
    expect(toastErrorMock).toHaveBeenCalledWith('Network unreachable');
  });

  it('sends nothing when the net delta is empty', () => {
    vi.useFakeTimers();
    seedReviewConfigCache([1, 2]);
    const { toggleRepo } = getToggleRepo(PERSONAL_SCOPE, 'github');

    toggleRepo(3);
    toggleRepo(3);

    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);

    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('clears the pending intent after a net-zero toggle so a later refetch does not resurrect it', () => {
    vi.useFakeTimers();
    seedReviewConfigCache([1, 2]);
    const { toggleRepo } = getToggleRepo(PERSONAL_SCOPE, 'github');

    // Toggle a repo on then off within the debounce window: the net delta is
    // empty, so the pending intent must clear to the server state.
    toggleRepo(3);
    toggleRepo(3);
    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);
    expect(mutateMock).not.toHaveBeenCalled();

    // A later refetch lands with a different server selection (e.g. a web
    // edit). The cleared intent must not re-apply the stale selection.
    fireRefetch(PERSONAL_SCOPE, [1, 4]);

    expect(reviewConfigCache?.selectedRepositoryIds).toEqual([1, 4]);

    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('diffs the next toggle against the last confirmed selection after a successful save', () => {
    vi.useFakeTimers();
    seedReviewConfigCache([1, 2]);
    const { toggleRepo, deltaOptions } = getToggleRepo(PERSONAL_SCOPE, 'github');

    toggleRepo(3);
    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);
    const firstVars = mutateMock.mock.calls[0]?.[0];
    deltaOptions.onSuccess?.({ success: true, webhookSync: null }, firstVars);

    toggleRepo(3);
    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);

    expect(mutateMock).toHaveBeenCalledTimes(2);
    expect(mutateMock.mock.calls[1]?.[0]).toEqual({
      add: [],
      remove: [3],
      optimisticSelection: [1, 2],
    });
  });

  it('re-sends a toggle made during the settle-to-refetch window so it stays visible', () => {
    vi.useFakeTimers();
    seedReviewConfigCache([1, 2]);
    const { toggleRepo, deltaOptions } = getToggleRepo(PERSONAL_SCOPE, 'github');

    toggleRepo(3);
    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);
    expect(mutateMock).toHaveBeenCalledTimes(1);
    const firstVars = mutateMock.mock.calls[0]?.[0];

    // A second toggle lands while the first save is still in flight.
    toggleRepo(4);

    // The first save settles, then the invalidation refetch lands with only
    // the first delta applied.
    deltaOptions.onSuccess?.({ success: true, webhookSync: null }, firstVars);
    fireRefetch(PERSONAL_SCOPE, [1, 2, 3]);

    // The refetch must not erase the pending toggle from the cache.
    expect(reviewConfigCache?.selectedRepositoryIds).toEqual([1, 2, 3, 4]);

    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);
    expect(mutateMock).toHaveBeenCalledTimes(2);
    expect(mutateMock.mock.calls[1]?.[0]).toEqual({
      add: [4],
      remove: [],
      optimisticSelection: [1, 2, 3, 4],
    });
  });

  it('resyncs the baseline with a refetched server selection so an external edit toggles correctly', () => {
    vi.useFakeTimers();
    seedReviewConfigCache([1]);
    const { toggleRepo, deltaOptions } = getToggleRepo(PERSONAL_SCOPE, 'github');

    // First toggle establishes a stale baseline of [1, 3].
    toggleRepo(3);
    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);
    const firstVars = mutateMock.mock.calls[0]?.[0];
    deltaOptions.onSuccess?.({ success: true, webhookSync: null }, firstVars);

    // External edit: the web app removes 3 and adds 2. A refetch lands.
    fireRefetch(PERSONAL_SCOPE, [1, 2]);

    // Toggling the externally-added repo must send remove:[2], not diff
    // against the stale [1, 3] baseline.
    toggleRepo(2);
    vi.advanceTimersByTime(REPO_SELECTION_DEBOUNCE_MS);

    expect(mutateMock).toHaveBeenCalledTimes(2);
    expect(mutateMock.mock.calls[1]?.[0]).toEqual({
      add: [],
      remove: [2],
      optimisticSelection: [1],
    });
  });
});

describe('useSaveReviewConfigDelta mutationFn payload shape', () => {
  it('sends a numeric delta for a personal github patch and drops string ids', async () => {
    const { deltaOptions } = getToggleRepo(PERSONAL_SCOPE, 'github');

    await deltaOptions.mutationFn?.({
      add: [3, 4, 'bitbucket-uuid'],
      remove: [1, 'bitbucket-uuid-2'],
      optimisticSelection: [2, 3, 4],
    });

    expect(personalPatchMutateMock).toHaveBeenCalledTimes(1);
    expect(personalPatchMutateMock.mock.calls[0]?.[0]).toEqual({
      platform: 'github',
      selectedRepositoryDelta: { add: [3, 4], remove: [1] },
    });
    expect(orgPatchMutateMock).not.toHaveBeenCalled();
  });

  it('sends a mixed delta and autoConfigureWebhooks for an org gitlab patch', async () => {
    const { deltaOptions } = getToggleRepo('org_42', 'gitlab');

    await deltaOptions.mutationFn?.({
      add: [3, 'bitbucket-uuid'],
      remove: [1],
      optimisticSelection: [3, 'bitbucket-uuid'],
    });

    expect(orgPatchMutateMock).toHaveBeenCalledTimes(1);
    expect(orgPatchMutateMock.mock.calls[0]?.[0]).toEqual({
      organizationId: 'org_42',
      platform: 'gitlab',
      selectedRepositoryDelta: { add: [3, 'bitbucket-uuid'], remove: [1] },
      autoConfigureWebhooks: true,
    });
    expect(personalPatchMutateMock).not.toHaveBeenCalled();
  });

  it('sends a numeric delta and autoConfigureWebhooks for a personal gitlab patch', async () => {
    const { deltaOptions } = getToggleRepo(PERSONAL_SCOPE, 'gitlab');

    await deltaOptions.mutationFn?.({
      add: [3],
      remove: [1],
      optimisticSelection: [3],
    });

    expect(personalPatchMutateMock).toHaveBeenCalledTimes(1);
    expect(personalPatchMutateMock.mock.calls[0]?.[0]).toEqual({
      platform: 'gitlab',
      selectedRepositoryDelta: { add: [3], remove: [1] },
      autoConfigureWebhooks: true,
    });
    expect(orgPatchMutateMock).not.toHaveBeenCalled();
  });

  it('writes the GitLab webhook warning flag when a delta save reports sync errors', async () => {
    orgPatchMutateMock.mockResolvedValue({
      success: true,
      webhookSync: { errors: ['repo 3 webhook sync failed'] },
    });
    const { deltaOptions } = getToggleRepo('org_42', 'gitlab');

    await deltaOptions.mutationFn?.({
      add: [3],
      remove: [],
      optimisticSelection: [3],
    });

    expect(setQueryDataMock).toHaveBeenCalledWith(
      ['codeReviewerGitLabWebhookWarning', 'org_42', 'gitlab'],
      true
    );
  });
});
