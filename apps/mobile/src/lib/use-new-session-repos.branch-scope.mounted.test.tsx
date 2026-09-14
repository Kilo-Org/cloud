/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/hooks/use-route-foreground-refresh.mounted.test.tsx */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake query factories settle without await because they resolve immediately (same header as use-new-session-repos.test.ts) */
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getNewSessionBranchState,
  type NewSessionRepository,
  resetNewSessionBranchScope,
  resetSelectedBranchOverrides,
} from '@/components/agents/new-session-repository-state';
import { useNewSessionRepos, useRepositoryBranches } from './use-new-session-repos';

/**
 * The branch fetch spy stands in for the network: every `listRepositoryBranches`
 * request the hooks issue lands here with its exact procedure input, so a test
 * can assert which organization a query actually executed against.
 */
const listBranches = vi.hoisted(() =>
  vi.fn(
    async (_input: unknown): Promise<unknown> => ({
      defaultBranch: 'main',
      branches: ['main'],
    })
  )
);

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

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
    refreshReposForceFresh: vi.fn(async () => undefined),
    isRefreshingRepos: false,
  }),
}));

// Real TanStack Query runs against these shapes: the list options carry a
// `queryFn` (tRPC's own `queryOptions` does), and the branch procedures resolve
// through the shared `listBranches` spy.
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { listRepositoryBranches: { query: listBranches } },
    organizations: { cloudAgentNext: { listRepositoryBranches: { query: listBranches } } },
  },
  useTRPC: () => ({
    cloudAgentNext: {
      listGitHubRepositories: {
        queryOptions: () => ({
          queryKey: ['github-personal'],
          queryFn: async () => ({ repositories: [], integrationInstalled: true }),
        }),
        queryKey: () => ['github-personal'],
      },
      listGitLabRepositories: {
        queryOptions: () => ({
          queryKey: ['gitlab-personal'],
          queryFn: async () => ({ repositories: [], integrationInstalled: true }),
        }),
        queryKey: () => ['gitlab-personal'],
      },
      listRepositoryBranches: { queryKey: (input: unknown) => ['branches', input] },
    },
    organizations: {
      cloudAgentNext: {
        listGitHubRepositories: {
          queryOptions: () => ({
            queryKey: ['github'],
            queryFn: async () => ({ repositories: [], integrationInstalled: true }),
          }),
          queryKey: () => ['github'],
        },
        listGitLabRepositories: {
          queryOptions: () => ({
            queryKey: ['gitlab'],
            queryFn: async () => ({ repositories: [], integrationInstalled: true }),
          }),
          queryKey: () => ['gitlab'],
        },
        listBitbucketRepositories: {
          queryOptions: () => ({
            queryKey: ['bitbucket'],
            queryFn: async () => ({ status: 'available', repositories: [] }),
          }),
          queryKey: () => ['bitbucket'],
        },
        listRepositoryBranches: { queryKey: (input: unknown) => ['org-branches', input] },
      },
    },
  }),
}));

type BranchesResult = ReturnType<typeof useRepositoryBranches>;

const githubRepo: NewSessionRepository = {
  platform: 'github',
  fullName: 'owner/repo',
  isPrivate: false,
};

/**
 * Mirrors the production tree: `useNewSessionRepos` publishes the scope from
 * the screen body while `useRepositoryBranches` reads it in a child rendered
 * below it, so child effects run before the publishing effect exactly as they
 * do in the app.
 */
function BranchSection({
  repository,
  resultRef,
}: {
  repository: NewSessionRepository | null;
  resultRef: { current: BranchesResult | null };
}) {
  resultRef.current = useRepositoryBranches(repository);
  return null;
}

function Screen({
  organizationId,
  repository,
  resultRef,
}: {
  organizationId: string | undefined;
  repository: NewSessionRepository | null;
  resultRef: { current: BranchesResult | null };
}) {
  useNewSessionRepos({ organizationId });
  return createElement(BranchSection, { repository, resultRef });
}

function mountedScreen(
  client: QueryClient,
  props: {
    organizationId: string | undefined;
    repository: NewSessionRepository | null;
    resultRef: { current: BranchesResult | null };
  }
): TestRenderer.ReactTestRenderer {
  const renderer: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    renderer.current = TestRenderer.create(
      createElement(QueryClientProvider, { client }, createElement(Screen, props))
    );
  });
  const created = renderer.current;
  if (created === null) {
    throw new Error('the screen did not render');
  }
  return created;
}

describe('new-session branch scope across an in-place organization change', () => {
  let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  beforeEach(() => {
    // Silences React's "environment is not configured to support act(...)"
    // warning, the same way the other mounted suites do.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    resetNewSessionBranchScope();
    resetSelectedBranchOverrides();
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it('executes no branch query against the previous organization after the scope prop changes', async () => {
    const resultRef: { current: BranchesResult | null } = { current: null };
    const props = {
      organizationId: 'org-1' as string | undefined,
      repository: githubRepo as NewSessionRepository | null,
      resultRef,
    };
    const renderer = mountedScreen(client, props);
    // Settle the org-1 branch fetch started by the mount effects.
    await act(async () => {
      await Promise.resolve();
    });

    // The scope is published, and the only branch fetch so far ran under the
    // scope that was live when the repository was selected.
    expect(getNewSessionBranchState()).toMatchObject({
      isScopeReady: true,
      organizationId: 'org-1',
    });
    expect(listBranches).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        platform: 'github',
        repository: { fullName: 'owner/repo' },
      })
    );
    const callsAtScopeChange = listBranches.mock.calls.length;

    // In-place organization change while the repository stays selected: the
    // screen body rerenders with the new scope before the publishing effect
    // has run, so the branch hook renders once against the previous scope.
    act(() => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client },
          createElement(Screen, { ...props, organizationId: 'org-2' })
        )
      );
    });
    // Settle the org-2 refetch started after the scope republished.
    await act(async () => {
      await Promise.resolve();
    });

    // The scope is republished from the prop, and every branch fetch issued
    // after the prop change ran against the new organization — the one-render
    // window must never let a query execute with `org-1`.
    expect(getNewSessionBranchState()).toMatchObject({
      isScopeReady: true,
      organizationId: 'org-2',
    });
    const callsAfterChange = listBranches.mock.calls.slice(callsAtScopeChange);
    expect(callsAfterChange.length).toBeGreaterThan(0);
    for (const call of callsAfterChange) {
      expect(call[0]).toMatchObject({ organizationId: 'org-2' });
    }
  });
});
