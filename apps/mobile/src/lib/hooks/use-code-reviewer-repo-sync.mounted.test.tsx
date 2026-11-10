import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import {
  type ReviewerRepositoriesResync,
  useReviewerRepositoriesResync,
} from './use-code-reviewer-repo-sync';

const state = vi.hoisted(() => ({
  queryPersonalGitHub: vi.fn(),
  queryPersonalGitLab: vi.fn(),
  queryOrgGitHub: vi.fn(),
  queryOrgGitLab: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner-native', () => ({ toast: { error: state.toastError } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    personalReviewAgent: {
      listGitHubRepositories: {
        queryOptions: (input: unknown) => ({ queryKey: ['personal-github', input] }),
      },
      listGitLabRepositories: {
        queryOptions: (input: unknown) => ({ queryKey: ['personal-gitlab', input] }),
      },
    },
    organizations: {
      reviewAgent: {
        listGitHubRepositories: {
          queryOptions: (input: unknown) => ({ queryKey: ['org-github', input] }),
        },
        listGitLabRepositories: {
          queryOptions: (input: unknown) => ({ queryKey: ['org-gitlab', input] }),
        },
      },
    },
  }),
  trpcClient: {
    personalReviewAgent: {
      listGitHubRepositories: { query: state.queryPersonalGitHub },
      listGitLabRepositories: { query: state.queryPersonalGitLab },
    },
    organizations: {
      reviewAgent: {
        listGitHubRepositories: { query: state.queryOrgGitHub },
        listGitLabRepositories: { query: state.queryOrgGitLab },
      },
    },
  },
}));

vi.mock('./use-code-reviewer', () => ({
  isPersonal: (scope: string) => scope === 'personal',
}));

const PERSONAL_GITHUB_KEY = ['personal-github', {}];
const ORG_GITHUB_KEY = ['org-github', { organizationId: 'org-1' }];

type HarnessProps = {
  scope: string;
  platform: 'github' | 'gitlab';
  publish: (value: ReviewerRepositoriesResync) => void;
};

function Harness({ scope, platform, publish }: HarnessProps) {
  publish(useReviewerRepositoriesResync(scope, platform));
  return createElement('Probe');
}

function snapshot() {
  return { repositories: [{ id: 1, fullName: 'acme/one' }], syncedAt: '2026-10-23T00:00:00.000Z' };
}

let queryClient = new QueryClient();

function mount(scope: string, platform: 'github' | 'gitlab') {
  let latest: ReviewerRepositoriesResync | null = null;
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Harness, {
          scope,
          platform,
          publish: value => {
            latest = value;
          },
        })
      )
    );
  });
  return {
    latest: () => {
      if (!latest) {
        throw new Error('hook never rendered');
      }
      return latest;
    },
    unmount: () => renderer?.unmount(),
  };
}

beforeEach(() => {
  state.queryPersonalGitHub.mockReset();
  state.queryPersonalGitLab.mockReset();
  state.queryOrgGitHub.mockReset();
  state.queryOrgGitLab.mockReset();
  state.toastError.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe('useReviewerRepositoriesResync', () => {
  it('forces the personal GitHub read and stores the answer under the read key', async () => {
    const data = snapshot();
    state.queryPersonalGitHub.mockResolvedValue(data);
    const mounted = mount('personal', 'github');

    await act(async () => {
      await mounted.latest().resync();
    });

    expect(state.queryPersonalGitHub).toHaveBeenCalledWith({ forceRefresh: true });
    expect(queryClient.getQueryData(PERSONAL_GITHUB_KEY)).toEqual(data);
    expect(mounted.latest().resyncing).toBe(false);
    mounted.unmount();
  });

  it('carries the organization through the forced GitHub read', async () => {
    const data = snapshot();
    state.queryOrgGitHub.mockResolvedValue(data);
    const mounted = mount('org-1', 'github');

    await act(async () => {
      await mounted.latest().resync();
    });

    expect(state.queryOrgGitHub).toHaveBeenCalledWith({
      organizationId: 'org-1',
      forceRefresh: true,
    });
    expect(queryClient.getQueryData(ORG_GITHUB_KEY)).toEqual(data);
    mounted.unmount();
  });

  it('forces the organization GitLab read', async () => {
    const data = snapshot();
    state.queryOrgGitLab.mockResolvedValue(data);
    const mounted = mount('org-1', 'gitlab');

    await act(async () => {
      await mounted.latest().resync();
    });

    expect(state.queryOrgGitLab).toHaveBeenCalledWith({
      organizationId: 'org-1',
      forceRefresh: true,
    });
    expect(state.queryPersonalGitLab).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('keeps the rows and reports a failed forced read', async () => {
    const previous = { repositories: [{ id: 7, fullName: 'acme/seven' }], syncedAt: null };
    queryClient.setQueryData(ORG_GITHUB_KEY, previous);
    state.queryOrgGitHub.mockRejectedValue(new Error('provider down'));
    const mounted = mount('org-1', 'github');

    await act(async () => {
      await mounted.latest().resync();
    });

    expect(queryClient.getQueryData(ORG_GITHUB_KEY)).toEqual(previous);
    expect(state.toastError).toHaveBeenCalledWith('common.couldNotRefresh');
    expect(mounted.latest().resyncing).toBe(false);
    mounted.unmount();
  });

  it('runs one forced read at a time', async () => {
    const pending = Promise.withResolvers<unknown>();
    state.queryPersonalGitHub.mockImplementation(() => pending.promise);
    const mounted = mount('personal', 'github');

    let first: Promise<void> | null = null;
    act(() => {
      first = mounted.latest().resync();
    });
    expect(mounted.latest().resyncing).toBe(true);
    await act(async () => {
      await mounted.latest().resync();
    });
    expect(state.queryPersonalGitHub).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(snapshot());
      await first;
    });
    expect(queryClient.getQueryData(PERSONAL_GITHUB_KEY)).toEqual(snapshot());
    expect(mounted.latest().resyncing).toBe(false);
    mounted.unmount();
  });

  it('keeps the cached list when the refresh is superseded', async () => {
    const previous = {
      repositories: [{ id: 7, fullName: 'previous-account/rows' }],
      syncedAt: '2026-10-22T00:00:00.000Z',
    };
    queryClient.setQueryData(PERSONAL_GITHUB_KEY, previous);
    const pending = Promise.withResolvers<unknown>();
    state.queryPersonalGitHub.mockImplementation(() => pending.promise);
    const mounted = mount('personal', 'github');

    let run: Promise<void> | null = null;
    act(() => {
      run = mounted.latest().resync();
    });
    // The refresh is superseded before the pending read answers.
    act(() => {
      bumpAuthEpoch();
    });
    await act(async () => {
      pending.resolve(snapshot());
      await run;
    });

    expect(queryClient.getQueryData(PERSONAL_GITHUB_KEY)).toEqual(previous);
    expect(state.toastError).not.toHaveBeenCalled();
    expect(mounted.latest().resyncing).toBe(false);
    mounted.unmount();
  });

  it('skips the failure report when the refresh is superseded', async () => {
    const pending = Promise.withResolvers<unknown>();
    state.queryOrgGitLab.mockImplementation(() => pending.promise);
    const mounted = mount('org-1', 'gitlab');

    let run: Promise<void> | null = null;
    act(() => {
      run = mounted.latest().resync();
    });
    act(() => {
      bumpAuthEpoch();
    });
    await act(async () => {
      pending.reject(new Error('provider down'));
      await run;
    });

    expect(state.toastError).not.toHaveBeenCalled();
    expect(mounted.latest().resyncing).toBe(false);
    mounted.unmount();
  });
});
