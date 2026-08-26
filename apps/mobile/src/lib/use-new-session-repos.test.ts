/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/components/agents/use-new-session-creator.test.ts */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake query factories settle without await because they resolve immediately */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNewSessionRepos } from './use-new-session-repos';

const mocks = vi.hoisted(() => ({
  fetchQuery: vi.fn(async (_opts: unknown): Promise<unknown> => ({})),
  setQueryData: vi.fn(() => undefined),
  toastError: vi.fn(),
  refreshGitHubForceFresh: vi.fn(async () => undefined),
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined, isLoading: false, isError: false, isRefetching: false }),
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
