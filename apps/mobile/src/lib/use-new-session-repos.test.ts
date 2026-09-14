/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/components/agents/use-new-session-creator.test.ts */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake query factories settle without await because they resolve immediately */
/* eslint-disable max-lines -- one mock harness serves the force-fresh suite and the branch-query suite; splitting it would duplicate every tRPC and react-query fake */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getNewSessionBranchState,
  getSelectedBranchOverride,
  type NewSessionRepository,
  setNewSessionBranchScope,
  setSelectedBranchOverride,
} from '@/components/agents/new-session-repository-state';
import { useNewSessionRepos, useRepositoryBranches } from './use-new-session-repos';

const mocks = vi.hoisted(() => ({
  fetchQuery: vi.fn(async (_opts: unknown): Promise<unknown> => ({})),
  setQueryData: vi.fn(() => undefined),
  toastError: vi.fn(),
  refreshGitHubForceFresh: vi.fn(async () => undefined),
  listBranches: vi.fn(
    async (_input: unknown): Promise<unknown> => ({
      defaultBranch: 'main',
      branches: ['main'],
    })
  ),
  /** Every `useQuery` call in mount order, so a test can read the branch query's options. */
  queryCalls: [] as { queryKey?: unknown[]; enabled?: boolean }[],
  /** Result the branch query (the one with a `queryFn`) reports. */
  branchQueryResult: emptyQueryResult(),
}));

function emptyQueryResult(): Record<string, unknown> {
  return {};
}

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@tanstack/react-query', () => ({
  // Records every call so the branch query's key and `enabled` can be asserted.
  // The provider queries have no `queryFn`; the branch query does, and only it
  // reads `branchQueryResult`.
  useQuery: (options: { queryKey?: unknown[]; enabled?: boolean; queryFn?: unknown }) => {
    mocks.queryCalls.push(options);
    const base = {
      data: undefined,
      isLoading: false,
      isPending: false,
      isError: false,
      isFetching: false,
      isRefetching: false,
      error: null,
      refetch: vi.fn(),
    };
    return options.queryFn ? { ...base, ...mocks.branchQueryResult } : base;
  },
  useQueryClient: () => ({ fetchQuery: mocks.fetchQuery, setQueryData: mocks.setQueryData }),
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));

vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useRecentAgentRepositories: () => ({ data: undefined }),
}));

vi.mock('@/lib/integration-urls', () => ({
  getGitLabIntegrationUrl: vi.fn(() => ''),
  getBitbucketIntegrationUrl: vi.fn(() => ''),
}));

vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: vi.fn(async () => 'sheet-close'),
}));

vi.mock('@/lib/external-auth/use-external-auth-return', () => ({
  useExternalAuthReturn: () => ({ markLaunched: vi.fn(), clearLaunch: vi.fn() }),
}));

vi.mock('@/lib/use-github-repos-refresh', () => ({
  useGitHubReposRefresh: () => ({
    openGitHubIntegration: vi.fn(),
    refreshReposForceFresh: mocks.refreshGitHubForceFresh,
    isRefreshingRepos: false,
    connectCheckFailed: false,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { listRepositoryBranches: { query: mocks.listBranches } },
    organizations: { cloudAgentNext: { listRepositoryBranches: { query: mocks.listBranches } } },
  },
  useTRPC: () => ({
    cloudAgentNext: {
      listGitHubRepositories: {
        queryOptions: () => ({ queryKey: ['github'] }),
        queryKey: () => ['github'],
      },
      listGitLabRepositories: {
        queryOptions: ({ forceRefresh }: { forceRefresh: boolean }) => ({
          queryKey: ['gitlab', forceRefresh],
        }),
        queryKey: ({ forceRefresh }: { forceRefresh: boolean }) => ['gitlab', forceRefresh],
      },
      listRepositoryBranches: {
        queryKey: (input: unknown) => ['branches', input],
      },
    },
    organizations: {
      cloudAgentNext: {
        listGitHubRepositories: {
          queryOptions: () => ({ queryKey: ['github'] }),
          queryKey: () => ['github'],
        },
        listGitLabRepositories: {
          queryOptions: ({ forceRefresh }: { forceRefresh: boolean }) => ({
            queryKey: ['gitlab', forceRefresh],
          }),
          queryKey: ({ forceRefresh }: { forceRefresh: boolean }) => ['gitlab', forceRefresh],
        },
        listBitbucketRepositories: {
          queryOptions: ({ forceRefresh }: { forceRefresh: boolean }) => ({
            queryKey: ['bitbucket', forceRefresh],
          }),
          queryKey: ({ forceRefresh }: { forceRefresh: boolean }) => ['bitbucket', forceRefresh],
        },
        listRepositoryBranches: {
          queryKey: (input: unknown) => ['org-branches', input],
        },
      },
    },
  }),
}));

type ReposResult = ReturnType<typeof useNewSessionRepos>;

function Harness({
  organizationId,
  resultRef,
}: {
  organizationId: string | undefined;
  resultRef: { current: ReposResult | null };
}) {
  const result = useNewSessionRepos({ organizationId });
  resultRef.current = result;
  return null;
}

function mountRepos(organizationId: string | undefined) {
  const resultRef: { current: ReposResult | null } = { current: null };
  act(() => {
    TestRenderer.create(React.createElement(Harness, { organizationId, resultRef }));
  });
  return resultRef;
}

function requireResult(resultRef: { current: ReposResult | null }): ReposResult {
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useNewSessionRepos did not run');
  }
  return result;
}

// Every provider's force-fresh reads `fetchQuery` with a `queryKey` whose first
// element names the provider, so the fake can answer Bitbucket and GitLab
// differently from one call site.
function mockFetchQuery(resultForBitbucket: unknown, gitlabAndGithub: unknown) {
  mocks.fetchQuery.mockImplementation(async (opts: unknown) => {
    const queryKey = (opts as { queryKey?: unknown[] }).queryKey;
    return Array.isArray(queryKey) && queryKey[0] === 'bitbucket'
      ? resultForBitbucket
      : gitlabAndGithub;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchQuery.mockImplementation(async (_opts: unknown) => ({ repositories: [] }));
  mocks.queryCalls.length = 0;
  mocks.branchQueryResult = {};
});

describe('useNewSessionRepos force-fresh Bitbucket cache write', () => {
  it('does not overwrite the normal cache and toasts when a force-fresh is temporarily unavailable', async () => {
    mockFetchQuery(
      { status: 'temporarily_unavailable', repositories: [] },
      { repositories: [], integrationInstalled: true }
    );
    const resultRef = mountRepos('org-1');

    await act(async () => {
      await requireResult(resultRef).refreshReposForceFresh();
    });

    // The Bitbucket forceRefresh:false key must stay untouched so an existing
    // `available` cache survives a transient outage.
    expect(mocks.setQueryData).not.toHaveBeenCalledWith(['bitbucket', false], expect.anything());
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Could not refresh repositories. Please try again.'
    );
  });

  it('writes the normal cache and stays silent when a force-fresh is available', async () => {
    const available = {
      status: 'available',
      repositories: [
        { fullName: 'workspace/repo', private: false, workspaceUuid: 'ws-1', id: 'id-1' },
      ],
    };
    mockFetchQuery(available, { repositories: [], integrationInstalled: true });
    const resultRef = mountRepos('org-1');

    await act(async () => {
      await requireResult(resultRef).refreshReposForceFresh();
    });

    expect(mocks.setQueryData).toHaveBeenCalledWith(['bitbucket', false], available);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});

// ── Branches of the selected repository ──────────────────────────────

type BranchesResult = ReturnType<typeof useRepositoryBranches>;

const githubRepo: NewSessionRepository = {
  platform: 'github',
  fullName: 'owner/repo',
  isPrivate: false,
};
const bitbucketRepo: NewSessionRepository = {
  platform: 'bitbucket',
  fullName: 'team/repo',
  isPrivate: true,
  workspaceUuid: 'ws-1',
  repositoryUuid: 'id-1',
};

function BranchHarness({
  repository,
  resultRef,
}: {
  repository: NewSessionRepository | null;
  resultRef: { current: BranchesResult | null };
}) {
  resultRef.current = useRepositoryBranches(repository);
  return null;
}

function mountBranches(repository: NewSessionRepository | null) {
  const resultRef: { current: BranchesResult | null } = { current: null };
  act(() => {
    TestRenderer.create(React.createElement(BranchHarness, { repository, resultRef }));
  });
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useRepositoryBranches did not run');
  }
  return result;
}

/** The recorded branch query — the only `useQuery` call that carries a `queryFn`. */
function branchQueryOptions() {
  const options = mocks.queryCalls.at(-1);
  if (!options) {
    throw new Error('no query was issued');
  }
  return options;
}

describe('useRepositoryBranches', () => {
  it('does not query until a repository is selected', () => {
    setNewSessionBranchScope(undefined);
    const result = mountBranches(null);

    expect(branchQueryOptions().enabled).toBe(false);
    expect(result.isEnabled).toBe(false);
    expect(result.isLoading).toBe(false);
  });

  it('queries the personal procedure for a selected repository', () => {
    setNewSessionBranchScope(undefined);
    const result = mountBranches(githubRepo);

    expect(result.isEnabled).toBe(true);
    expect(branchQueryOptions().enabled).toBe(true);
    expect(branchQueryOptions().queryKey?.[0]).toBe('branches');
  });

  it('queries the organization procedure inside an organization', () => {
    setNewSessionBranchScope('org-1');
    mountBranches(githubRepo);

    expect(branchQueryOptions().queryKey?.[0]).toBe('org-branches');
    expect(branchQueryOptions().queryKey?.[1]).toMatchObject({
      organizationId: 'org-1',
      platform: 'github',
      repository: { fullName: 'owner/repo' },
    });
  });

  it('keys the cache by the full repository identity, uuids included', () => {
    setNewSessionBranchScope('org-1');
    mountBranches(bitbucketRepo);
    const first = branchQueryOptions().queryKey;
    mountBranches({ ...bitbucketRepo, workspaceUuid: 'ws-2', repositoryUuid: 'id-2' });
    const second = branchQueryOptions().queryKey;

    expect(first).not.toEqual(second);
  });

  it('never queries a personal Bitbucket repository (organizations only)', () => {
    setNewSessionBranchScope(undefined);
    const result = mountBranches(bitbucketRepo);

    expect(result.isEnabled).toBe(false);
    expect(branchQueryOptions().enabled).toBe(false);
  });

  it('waits for the route to publish the organization scope before querying', async () => {
    // `undefined` is a real scope (a personal session), so "not published yet"
    // has to be its own state — otherwise the first render would query the
    // personal procedure for what is about to be an organization session.
    vi.resetModules();
    const fresh = await import('./use-new-session-repos');
    const resultRef: { current: BranchesResult | null } = { current: null };
    function FreshHarness() {
      resultRef.current = fresh.useRepositoryBranches(githubRepo);
      return null;
    }
    act(() => {
      TestRenderer.create(React.createElement(FreshHarness));
    });

    expect(resultRef.current?.isEnabled).toBe(false);
    expect(branchQueryOptions().enabled).toBe(false);
  });

  it('reports a transient failure as retryable', () => {
    setNewSessionBranchScope(undefined);
    mocks.branchQueryResult = {
      isError: true,
      error: { data: { code: 'BAD_GATEWAY' } },
    };
    const result = mountBranches(githubRepo);

    expect(result.isRetryableError).toBe(true);
    expect(result.isPermanentError).toBe(false);
  });

  it('reports a refusal a retry cannot fix as permanent', () => {
    setNewSessionBranchScope(undefined);
    mocks.branchQueryResult = { isError: true, error: { data: { code: 'FORBIDDEN' } } };
    const result = mountBranches(githubRepo);

    expect(result.isPermanentError).toBe(true);
    expect(result.isRetryableError).toBe(false);
  });

  it('reports the provider default and an empty list without an override', () => {
    setNewSessionBranchScope(undefined);
    mocks.branchQueryResult = { data: { defaultBranch: null, branches: [] } };
    const result = mountBranches(githubRepo);

    expect(result.branches).toEqual([]);
    expect(result.defaultBranch).toBeNull();
    expect(getSelectedBranchOverride(githubRepo)).toBeNull();
  });

  it('fetches through the organization procedure when the query runs', async () => {
    setNewSessionBranchScope('org-1');
    mountBranches(githubRepo);
    const queryFn = (branchQueryOptions() as { queryFn?: () => Promise<unknown> }).queryFn;

    await queryFn?.();

    expect(mocks.listBranches).toHaveBeenCalledWith({
      organizationId: 'org-1',
      platform: 'github',
      repository: { fullName: 'owner/repo' },
    });
  });
});

describe('branch overrides across a repository change', () => {
  it('drops a branch chosen for another repository', () => {
    setSelectedBranchOverride(githubRepo, 'release/2.0');
    expect(getSelectedBranchOverride(githubRepo)).toBe('release/2.0');
    expect(getSelectedBranchOverride({ ...githubRepo, platform: 'gitlab' })).toBeNull();
  });
});

describe('useNewSessionRepos published branch scope', () => {
  it('drops the organization scope on unmount so a remount cannot query the previous screen’s org', () => {
    const resultRef: { current: ReposResult | null } = { current: null };
    const renderer: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
    act(() => {
      renderer.current = TestRenderer.create(
        React.createElement(Harness, { organizationId: 'org-1', resultRef })
      );
    });
    expect(getNewSessionBranchState()).toMatchObject({
      isScopeReady: true,
      organizationId: 'org-1',
    });

    act(() => {
      renderer.current?.unmount();
    });

    // The scope is "not ready" again, not a stale organization and not an
    // implicit personal scope: the next screen publishes its own.
    expect(getNewSessionBranchState()).toMatchObject({
      isScopeReady: false,
      organizationId: undefined,
    });

    mocks.queryCalls.length = 0;
    const branches = mountBranches(githubRepo);
    expect(branches.isEnabled).toBe(false);
    expect(branchQueryOptions().enabled).toBe(false);
  });
});
