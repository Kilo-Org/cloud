// Mounted regression for the branch settle bound (23-7): the expiry belongs to
// one question and one request, so a retry or a return to the same repository
// starts loading again instead of inheriting the previous expiry.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { type NewSessionRepository } from '@/components/agents/new-session-repository-state';
import { type RepositoryBranchesState, useRepositoryBranches } from './use-new-session-repos';

/** The branch query options this suite records. */
type QueryOptions = { queryKey?: unknown[]; enabled?: boolean; queryFn?: unknown };

/** The fake query result a test installs for the branch query. */
type BranchQueryView = {
  isPending?: boolean;
  isFetching?: boolean;
  isError?: boolean;
  error?: unknown;
  data?: { defaultBranch: string; branches: string[]; truncated?: boolean };
  refetch: () => void;
};

/** The harness's own state: the fake query result and what the hook returned. */
type World = {
  query: BranchQueryView;
  calls: QueryOptions[];
  result: RepositoryBranchesState | null;
  /** Every frame the harness rendered, in order, so a case can inspect the first. */
  frames: RepositoryBranchesState[];
};

const world = vi.hoisted(() => {
  const holder: World = {
    query: { refetch: () => undefined },
    calls: [],
    result: null,
    frames: [],
  };
  return holder;
});

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: QueryOptions) => {
    world.calls.push(options);
    const base = {
      data: undefined,
      isLoading: false,
      isPending: false,
      isError: false,
      isFetching: false,
      isRefetching: false,
      error: null,
      refetch: () => undefined,
    };
    return options.queryFn ? { ...base, ...world.query } : base;
  },
  useQueryClient: () => ({ query: vi.fn(), setQueryData: vi.fn() }),
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));

vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useRecentAgentRepositories: () => ({ data: undefined }),
}));

vi.mock('@/lib/integration-urls', () => ({
  getBitbucketIntegrationUrl: vi.fn(() => 'bitbucket-url'),
}));

vi.mock('@/lib/app-shell-handoff', () => ({
  appShellHandoffUrl: vi.fn(() => Promise.resolve('gitlab-handoff-url')),
}));

vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: vi.fn(),
  reportLateLaunchFailure: vi.fn(),
}));

vi.mock('@/lib/use-github-repos-refresh', () => ({
  useGitHubReposRefresh: () => ({
    openGitHubIntegration: vi.fn(),
    refreshReposForceFresh: vi.fn(),
    isRefreshingRepos: false,
    connectCheckFailed: false,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { listRepositoryBranches: { query: vi.fn() } },
    organizations: { cloudAgentNext: { listRepositoryBranches: { query: vi.fn() } } },
  },
  useTRPC: () => ({
    cloudAgentNext: {
      listGitHubRepositories: {
        queryOptions: () => ({ queryKey: ['github'] }),
        queryKey: () => ['github'],
      },
      listGitLabRepositories: {
        queryOptions: () => ({ queryKey: ['gitlab'] }),
        queryKey: () => ['gitlab'],
      },
      listRepositoryBranches: { queryKey: (input: unknown) => ['branches', input] },
    },
    organizations: {
      cloudAgentNext: {
        listGitHubRepositories: {
          queryOptions: () => ({ queryKey: ['org-github'] }),
          queryKey: () => ['org-github'],
        },
        listGitLabRepositories: {
          queryOptions: () => ({ queryKey: ['org-gitlab'] }),
          queryKey: () => ['org-gitlab'],
        },
        listRepositoryBranches: { queryKey: (input: unknown) => ['org-branches', input] },
      },
    },
  }),
}));

const REPOSITORY: NewSessionRepository = {
  platform: 'github',
  fullName: 'owner/repo',
  isPrivate: false,
};

const OTHER_REPOSITORY: NewSessionRepository = { ...REPOSITORY, fullName: 'owner/other' };

const SETTLE_BOUND_MS = 15_000;

function BranchHarness({ repository }: { repository: NewSessionRepository }) {
  world.result = useRepositoryBranches(repository, undefined);
  world.frames.push(world.result);
  return null;
}

function mountBranches(repository: NewSessionRepository) {
  const held: { renderer?: TestRenderer.ReactTestRenderer } = {};
  function current(): RepositoryBranchesState {
    const result = world.result;
    if (result === null) {
      throw new Error('useRepositoryBranches did not run');
    }
    return result;
  }
  act(() => {
    held.renderer = TestRenderer.create(createElement(BranchHarness, { repository }));
  });
  return {
    result: current,
    rerender(next: NewSessionRepository) {
      act(() => {
        held.renderer?.update(createElement(BranchHarness, { repository: next }));
      });
      return current();
    },
    unmount() {
      act(() => {
        held.renderer?.unmount();
      });
    },
  };
}

beforeEach(() => {
  world.calls.length = 0;
  world.frames.length = 0;
  world.query = { isPending: true, isFetching: true, refetch: vi.fn(() => undefined) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('branch settle bound scoped to the request', () => {
  it('a retry while the original request is still pending shows the loading state again instead of the retry row', () => {
    vi.useFakeTimers();
    const mounted = mountBranches(REPOSITORY);

    expect(mounted.result().isLoading).toBe(true);
    expect(mounted.result().isRetryableError).toBe(false);

    act(() => {
      vi.advanceTimersByTime(SETTLE_BOUND_MS);
    });
    expect(mounted.result().isLoading).toBe(false);
    expect(mounted.result().isRetryableError).toBe(true);

    act(() => {
      mounted.result().retry();
    });

    // The retry asked again, so the row reports the request it is waiting on
    // rather than the bound the previous one missed.
    expect(mounted.result().isLoading).toBe(true);
    expect(mounted.result().isRetryableError).toBe(false);
    expect(world.query.refetch).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('returning to a repository that is still pending does not render its old expiry', () => {
    vi.useFakeTimers();
    const mounted = mountBranches(REPOSITORY);

    act(() => {
      vi.advanceTimersByTime(SETTLE_BOUND_MS);
    });
    expect(mounted.result().isRetryableError).toBe(true);

    mounted.rerender(OTHER_REPOSITORY);
    const returned = mounted.rerender(REPOSITORY);

    // The first frame after coming back is a fresh question: it is loading, not
    // the expiry the previous visit left behind.
    expect(returned.isLoading).toBe(true);
    expect(returned.isRetryableError).toBe(false);

    act(() => {
      vi.advanceTimersByTime(SETTLE_BOUND_MS);
    });
    expect(mounted.result().isRetryableError).toBe(true);
    mounted.unmount();
  });

  it('returning to a pending repository from one that asked for nothing renders no expiry frame', () => {
    vi.useFakeTimers();
    const mounted = mountBranches(REPOSITORY);

    act(() => {
      vi.advanceTimersByTime(SETTLE_BOUND_MS);
    });
    expect(mounted.result().isRetryableError).toBe(true);

    // A cached repository asks for nothing, so no request starts while it is
    // selected and the expiry the previous visit armed stays put.
    world.query = { isPending: false, isFetching: false, refetch: vi.fn(() => undefined) };
    mounted.rerender(OTHER_REPOSITORY);
    expect(mounted.result().isRetryableError).toBe(false);

    // The repository is asked about again and its request is out, so no frame of
    // the switch — not even the first, before the effect runs — may show the
    // expiry the visit before left behind.
    world.query = { isPending: true, isFetching: false, refetch: vi.fn(() => undefined) };
    world.frames.length = 0;
    mounted.rerender(REPOSITORY);
    expect(world.frames.length).toBeGreaterThan(0);
    expect(world.frames.every(frame => frame.isLoading)).toBe(true);
    expect(world.frames.every(frame => frame.isRetryableError)).toBe(false);

    mounted.unmount();
  });
});
