// Mounted regression for the Refresh repositories toast: the providers that
// fail in one refresh share one toast, and a refresh that failed only because
// the session ended stays silent, so no toast lands over the login screen.

import { createElement } from 'react';
import { toast } from 'sonner-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

import { useNewSessionRepos } from './use-new-session-repos';

type QueryOptions = { queryKey: string[] };

const world = vi.hoisted(() => ({
  query: vi.fn<(options: QueryOptions) => Promise<unknown>>(),
  refresh: null as (() => Promise<void>) | null,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: () => undefined,
}));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    isRefetching: false,
  }),
  useQueryClient: () => ({ query: world.query, setQueryData: vi.fn() }),
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://app.example.com' }));

vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useRecentAgentRepositories: () => ({ data: undefined }),
}));

vi.mock('@/lib/app-shell-handoff', () => ({ appShellHandoffUrl: vi.fn() }));

vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: vi.fn(),
  reportLateLaunchFailure: vi.fn(),
}));

function provider(name: string) {
  return {
    queryOptions: () => ({ queryKey: [name] }),
    queryKey: () => [name],
  };
}

vi.mock('@/lib/trpc', () => ({
  trpcClient: {},
  useTRPC: () => ({
    cloudAgentNext: {
      listGitHubRepositories: provider('github'),
      listGitLabRepositories: provider('gitlab'),
    },
    organizations: {
      cloudAgentNext: {
        listGitHubRepositories: provider('github'),
        listGitLabRepositories: provider('gitlab'),
        listBitbucketRepositories: provider('bitbucket'),
      },
    },
  }),
}));

const sessionEnded = Object.assign(new Error('UNAUTHORIZED'), {
  data: { code: 'UNAUTHORIZED', httpStatus: 401, authRequired: true },
});

function failProviders(failures: Record<string, Error>): void {
  world.query.mockImplementation(options => {
    const failure = failures[options.queryKey[0] ?? ''];
    if (failure) {
      return Promise.reject(failure);
    }
    return Promise.resolve({ integrationInstalled: true, repositories: [] });
  });
}

function Harness() {
  world.refresh = useNewSessionRepos({ organizationId: undefined }).refreshReposForceFresh;
  return null;
}

async function refreshRepositories(): Promise<void> {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(Harness));
  });
  await act(async () => {
    await world.refresh?.();
  });
  act(() => {
    renderer?.unmount();
  });
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  world.query.mockReset();
});

describe('useNewSessionRepos refreshReposForceFresh', () => {
  it('shows one toast when GitHub and GitLab both fail', async () => {
    failProviders({ github: new Error('network'), gitlab: new Error('network') });
    await refreshRepositories();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      i18n.t('agentChat.newSession.couldNotRefreshRepositories')
    );
  });

  it('shows the toast when only GitHub fails', async () => {
    failProviders({ github: new Error('network') });
    await refreshRepositories();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('shows no toast when the refresh failed because the session ended', async () => {
    failProviders({ github: sessionEnded, gitlab: sessionEnded });
    await refreshRepositories();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows no toast when every provider refreshes', async () => {
    failProviders({});
    await refreshRepositories();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
