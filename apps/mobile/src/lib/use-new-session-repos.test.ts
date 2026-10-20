/* eslint-disable require-await, @typescript-eslint/require-await -- the fake query factories settle without await because they resolve immediately */
/* eslint-disable max-lines -- one mock harness serves the force-fresh suite and the branch-query suite; splitting it would duplicate every tRPC and react-query fake */
import * as React from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getSelectedBranchOverride,
  type NewSessionRepository,
  setSelectedBranchOverride,
} from '@/components/agents/new-session-repository-state';
import { useNewSessionRepos, useRepositoryBranches } from './use-new-session-repos';

const mocks = vi.hoisted(() => ({
  query: vi.fn(async (_opts: unknown): Promise<unknown> => ({})),
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
  queryCalls: [] as { queryKey?: unknown[]; enabled?: boolean; staleTime?: number }[],
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
  useQuery: (options: {
    queryKey?: unknown[];
    enabled?: boolean;
    staleTime?: number;
    queryFn?: unknown;
  }) => {
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
  useQueryClient: () => ({ query: mocks.query, setQueryData: mocks.setQueryData }),
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
  openAuthorizationAndWaitForReturn: vi.fn(async () => undefined),
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
        queryOptions: (_input: unknown, opts?: Record<string, unknown>) => ({
          queryKey: ['github'],
          ...opts,
        }),
        queryKey: () => ['github'],
      },
      listGitLabRepositories: {
        queryOptions: (
          { forceRefresh }: { forceRefresh: boolean },
          opts?: Record<string, unknown>
        ) => ({
          queryKey: ['gitlab', forceRefresh],
          ...opts,
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
          queryOptions: (_input: unknown, opts?: Record<string, unknown>) => ({
            queryKey: ['github'],
            ...opts,
          }),
          queryKey: () => ['github'],
        },
        listGitLabRepositories: {
          queryOptions: (
            { forceRefresh }: { forceRefresh: boolean },
            opts?: Record<string, unknown>
          ) => ({
            queryKey: ['gitlab', forceRefresh],
            ...opts,
          }),
          queryKey: ({ forceRefresh }: { forceRefresh: boolean }) => ['gitlab', forceRefresh],
        },
        listBitbucketRepositories: {
          queryOptions: (
            { forceRefresh }: { forceRefresh: boolean },
            opts?: Record<string, unknown>
          ) => ({
            queryKey: ['bitbucket', forceRefresh],
            ...opts,
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

// Every provider's force-fresh reads `query` with a `queryKey` whose first
// element names the provider, so the fake can answer Bitbucket and GitLab
// differently from one call site.
function mockFetchQuery(resultForBitbucket: unknown, gitlabAndGithub: unknown) {
  mocks.query.mockImplementation(async (opts: unknown) => {
    const queryKey = (opts as { queryKey?: unknown[] }).queryKey;
    return Array.isArray(queryKey) && queryKey[0] === 'bitbucket'
      ? resultForBitbucket
      : gitlabAndGithub;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockImplementation(async (_opts: unknown) => ({ repositories: [] }));
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

describe('useNewSessionRepos provider staleTime', () => {
  // The three provider list queries are expensive, so they must not refetch on
  // every mount of the new-session form. The force-fresh flows above write
  // fresh results into these same keys.
  function expectProviderStaleTime() {
    expect(mocks.queryCalls.map(options => options.queryKey?.[0])).toEqual([
      'github',
      'gitlab',
      'bitbucket',
    ]);
    for (const options of mocks.queryCalls) {
      expect(options.staleTime).toBe(300_000);
    }
  }

  it('gives every provider repository query a five-minute staleTime (personal)', () => {
    mountRepos(undefined);

    expectProviderStaleTime();
  });

  it('gives every provider repository query a five-minute staleTime (organization)', () => {
    mountRepos('org-1');

    expectProviderStaleTime();
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
  organizationId,
  resultRef,
}: {
  repository: NewSessionRepository | null;
  organizationId: string | undefined;
  resultRef: { current: BranchesResult | null };
}) {
  resultRef.current = useRepositoryBranches(repository, organizationId);
  return null;
}

function mountBranches(repository: NewSessionRepository | null, organizationId?: string) {
  const resultRef: { current: BranchesResult | null } = { current: null };
  act(() => {
    TestRenderer.create(
      React.createElement(BranchHarness, { repository, organizationId, resultRef })
    );
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
    const result = mountBranches(null);

    expect(branchQueryOptions().enabled).toBe(false);
    expect(result.isEnabled).toBe(false);
    expect(result.isLoading).toBe(false);
  });

  it('queries the personal procedure for a selected repository', () => {
    const result = mountBranches(githubRepo);

    expect(result.isEnabled).toBe(true);
    expect(branchQueryOptions().enabled).toBe(true);
    expect(branchQueryOptions().queryKey?.[0]).toBe('branches');
  });

  it('queries the organization procedure inside an organization', () => {
    mountBranches(githubRepo, 'org-1');

    expect(branchQueryOptions().queryKey?.[0]).toBe('org-branches');
    expect(branchQueryOptions().queryKey?.[1]).toMatchObject({
      organizationId: 'org-1',
      platform: 'github',
      repository: { fullName: 'owner/repo' },
    });
  });

  it('keys the cache by the full repository identity, uuids included', () => {
    mountBranches(bitbucketRepo, 'org-1');
    const first = branchQueryOptions().queryKey;
    mountBranches({ ...bitbucketRepo, workspaceUuid: 'ws-2', repositoryUuid: 'id-2' }, 'org-1');
    const second = branchQueryOptions().queryKey;

    expect(first).not.toEqual(second);
  });

  it('never queries a personal Bitbucket repository (organizations only)', () => {
    const result = mountBranches(bitbucketRepo);

    expect(result.isEnabled).toBe(false);
    expect(branchQueryOptions().enabled).toBe(false);
  });

  it('moves the query to the new organization on the render that changes the prop', () => {
    // The scope is a PROP, so an in-place org change must never leave a render
    // in which the branch query still targets the previous organization.
    const resultRef: { current: BranchesResult | null } = { current: null };
    const renderer: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
    act(() => {
      renderer.current = TestRenderer.create(
        React.createElement(BranchHarness, {
          repository: githubRepo,
          organizationId: 'org-1',
          resultRef,
        })
      );
    });
    expect(branchQueryOptions().queryKey?.[1]).toMatchObject({ organizationId: 'org-1' });

    mocks.queryCalls.length = 0;
    act(() => {
      renderer.current?.update(
        React.createElement(BranchHarness, {
          repository: githubRepo,
          organizationId: 'org-2',
          resultRef,
        })
      );
    });

    expect(resultRef.current?.isEnabled).toBe(true);
    const afterChange = mocks.queryCalls.filter(options => options.enabled !== false);
    expect(afterChange.length).toBeGreaterThan(0);
    for (const options of afterChange) {
      expect(options.queryKey?.[1]).toMatchObject({ organizationId: 'org-2' });
    }
  });

  it('reports a transient failure as retryable', () => {
    mocks.branchQueryResult = {
      isError: true,
      error: { data: { code: 'BAD_GATEWAY' } },
    };
    const result = mountBranches(githubRepo);

    expect(result.isRetryableError).toBe(true);
    expect(result.isPermanentError).toBe(false);
  });

  it('reports a refusal a retry cannot fix as permanent', () => {
    mocks.branchQueryResult = { isError: true, error: { data: { code: 'FORBIDDEN' } } };
    const result = mountBranches(githubRepo);

    expect(result.isPermanentError).toBe(true);
    expect(result.isRetryableError).toBe(false);
  });

  it('reports the provider default and an empty list without an override', () => {
    mocks.branchQueryResult = { data: { defaultBranch: null, branches: [] } };
    const result = mountBranches(githubRepo);

    expect(result.branches).toEqual([]);
    expect(result.defaultBranch).toBeNull();
    expect(getSelectedBranchOverride(githubRepo)).toBeNull();
  });

  it('fetches through the organization procedure when the query runs', async () => {
    mountBranches(githubRepo, 'org-1');
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
