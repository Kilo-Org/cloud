import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  setQueryData: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: state.setQueryData }),
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

function mount(scope: string, platform: 'github' | 'gitlab') {
  let latest: ReviewerRepositoriesResync | null = null;
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = TestRenderer.create(
      createElement(Harness, {
        scope,
        platform,
        publish: value => {
          latest = value;
        },
      })
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
  state.setQueryData.mockReset();
  state.toastError.mockReset();
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
    expect(state.setQueryData).toHaveBeenCalledWith(['personal-github', {}], data);
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
    expect(state.setQueryData).toHaveBeenCalledWith(
      ['org-github', { organizationId: 'org-1' }],
      data
    );
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
    state.queryOrgGitHub.mockRejectedValue(new Error('provider down'));
    const mounted = mount('org-1', 'github');

    await act(async () => {
      await mounted.latest().resync();
    });

    expect(state.setQueryData).not.toHaveBeenCalled();
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
    expect(state.setQueryData).toHaveBeenCalledTimes(1);
    expect(mounted.latest().resyncing).toBe(false);
    mounted.unmount();
  });
});
