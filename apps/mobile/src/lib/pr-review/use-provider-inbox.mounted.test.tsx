import './use-provider-inbox.test-helpers';
import { act, createElement } from 'react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { PrReviewInboxList } from '@/components/pr-review/pr-review-inbox-list';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { useProviderInbox } from './use-provider-inbox';

const mocks = vi.hoisted(() => ({
  authorization: vi.fn(),
  githubPage: vi.fn(),
  providerPage: vi.fn(),
  gitlabConnected: true,
  organizationId: null as string | null,
}));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: mocks.organizationId }),
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useGitLabStatus: () => ({ data: { connected: mocks.gitlabConnected } }),
  useBitbucketReadiness: () => ({ data: { connected: false } }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: {
        queryOptions: () => ({ queryKey: ['authorization'], queryFn: mocks.authorization }),
      },
    },
    githubPrReview: {
      pathFilter: () => ({ queryKey: ['github-inbox'] }),
      listInbox: {
        infiniteQueryOptions: (_input: unknown, options: object) => ({
          queryKey: ['github-inbox'],
          queryFn: mocks.githubPage,
          initialPageParam: undefined,
          ...options,
        }),
      },
    },
    providerReview: {
      listInbox: {
        infiniteQueryOptions: (input: { platform: string }, options: object) => ({
          queryKey: ['provider-inbox', input],
          queryFn: mocks.providerPage,
          initialPageParam: undefined,
          ...options,
        }),
      },
    },
  }),
}));

const githubItem = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  title: 'GitHub PR',
  isDraft: false,
  updatedAt: '',
};
const gitlabItem = {
  ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 1 },
  title: 'GitLab MR',
  draft: false,
  updatedAt: '',
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.organizationId = null;
  mocks.gitlabConnected = true;
  mocks.authorization.mockResolvedValue({ connected: false });
  mocks.githubPage.mockResolvedValue({ items: [githubItem], nextCursor: null });
  mocks.providerPage.mockResolvedValue({ items: [gitlabItem], nextCursor: null });
});

async function mountInbox(enabled = true) {
  let inbox: ReturnType<typeof useProviderInbox> | undefined = undefined;
  function Harness() {
    inbox = useProviderInbox(enabled);
    return null;
  }
  const mounted = await renderWithProviders(createElement(Harness));
  onTestFinished(mounted.unmount);
  return {
    ...mounted,
    inbox: () => {
      if (!inbox) {
        throw new Error('Inbox did not mount');
      }
      return inbox;
    },
  };
}

function hosts(mounted: Awaited<ReturnType<typeof renderWithProviders>>, type: string) {
  return mounted.renderer.root.findAll(node => node.type === type);
}

describe('GitHub inbox authorization', () => {
  it('keeps an empty inbox loading while authorization is pending', async () => {
    mocks.gitlabConnected = false;
    mocks.authorization.mockReturnValue(Promise.withResolvers().promise);
    const mounted = await mountInbox();
    expect(mounted.inbox().isPending).toBe(true);
    expect(mocks.githubPage).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'retries a failed authorization check, GitLab connected=%s',
    async gitlabConnected => {
      mocks.gitlabConnected = gitlabConnected;
      mocks.authorization.mockRejectedValue(new Error('Status unavailable'));
      const mounted = await mountInbox();
      await waitFor(
        () => mounted.inbox().laterPageError || mounted.inbox().firstPageErrorState !== null
      );
      expect(mounted.inbox().isPending).toBe(false);
      expect(mocks.githubPage).not.toHaveBeenCalled();
      mocks.authorization.mockResolvedValue({ connected: true });
      act(() => {
        if (gitlabConnected) {
          mounted.inbox().retryFailedPages();
        } else {
          mounted.inbox().refetch();
        }
      });
      await waitFor(() => mocks.githubPage.mock.calls.length === 1);
    }
  );

  it.each([undefined, { connected: false }, { connected: false, revoked: true }])(
    'does not query or retry GitHub without user authorization (%j)',
    async authorization => {
      if (authorization === undefined) {
        mocks.authorization.mockReturnValue(Promise.withResolvers().promise);
      } else {
        mocks.authorization.mockResolvedValue(authorization);
      }
      const mounted = await mountInbox();
      await waitFor(() => mounted.inbox().items.length > 0);
      expect(mounted.inbox().items.map(row => row.title)).toEqual(['GitLab MR']);
      act(() => {
        mounted.inbox().refetch();
        mounted.inbox().fetchNextPage();
        mounted.inbox().retryFailedPages();
      });
      expect(mocks.githubPage).not.toHaveBeenCalled();
      expect(mounted.inbox().laterPageError).toBe(false);
      expect(mounted.inbox().firstPageErrorState).toBeNull();
    }
  );

  it('loads GitHub after authorization resolves, including in organization context', async () => {
    mocks.organizationId = 'org-1';
    const authorization = Promise.withResolvers<{ connected: boolean }>();
    mocks.authorization.mockReturnValue(authorization.promise);
    const mounted = await mountInbox();
    expect(mocks.githubPage).not.toHaveBeenCalled();
    act(() => {
      authorization.resolve({ connected: true });
    });
    await waitFor(() => mounted.inbox().items.length === 2);
    expect(mocks.githubPage).toHaveBeenCalledTimes(1);
  });

  it('ignores cached GitHub pages after disconnect, including their pagination cursor', async () => {
    mocks.authorization.mockResolvedValue({ connected: true });
    mocks.githubPage.mockResolvedValue({ items: [githubItem], nextCursor: 'page-2' });
    const mounted = await mountInbox();
    await waitFor(() => mounted.inbox().items.length === 2);
    act(() => {
      mounted.queryClient.setQueryData(['authorization'], { connected: false });
    });
    await waitFor(() => mounted.inbox().items.length === 1);
    expect(mounted.inbox().items.map(row => row.title)).toEqual(['GitLab MR']);
    mocks.githubPage.mockClear();
    act(() => {
      mounted.inbox().refetch();
      mounted.inbox().fetchNextPage();
      mounted.inbox().retryFailedPages();
    });
    expect(mocks.githubPage).not.toHaveBeenCalled();
    expect(mounted.inbox().hasNextPage).toBe(false);
  });

  it('keeps connected GitHub failures retryable without reloading healthy GitLab pages', async () => {
    mocks.authorization.mockResolvedValue({ connected: true });
    mocks.githubPage.mockRejectedValue(new Error('GitHub unavailable'));
    const mounted = await mountInbox();
    await waitFor(() => mounted.inbox().laterPageError);
    expect(mounted.inbox().items.map(row => row.title)).toEqual(['GitLab MR']);
    mocks.githubPage.mockResolvedValue({ items: [githubItem], nextCursor: null });
    mocks.providerPage.mockClear();
    act(() => {
      mounted.inbox().retryFailedPages();
    });
    await waitFor(() => mounted.inbox().items.length === 2);
    expect(mocks.providerPage).not.toHaveBeenCalled();
  });

  it('stays empty without an inbox error when no provider is connected', async () => {
    mocks.gitlabConnected = false;
    const mounted = await mountInbox();
    await waitFor(() => !mounted.inbox().isPending);
    expect(mounted.inbox().items).toEqual([]);
    expect(mounted.inbox().isPending).toBe(false);
    expect(mounted.inbox().firstPageErrorState).toBeNull();
    expect(mocks.githubPage).not.toHaveBeenCalled();
  });

  it('does not load or manually refetch a disabled inbox', async () => {
    mocks.authorization.mockResolvedValue({ connected: true });
    const mounted = await mountInbox(false);
    act(() => {
      mounted.inbox().refetch();
    });
    expect(mocks.githubPage).not.toHaveBeenCalled();
    expect(mocks.providerPage).not.toHaveBeenCalled();
  });
});

describe('revoked GitHub inbox recovery', () => {
  it('keeps a failed empty GitLab refresh retryable alongside GitHub reconnection', async () => {
    mocks.authorization.mockResolvedValue({ connected: false, revoked: true });
    mocks.providerPage.mockResolvedValue({ items: [], nextCursor: null });
    const mounted = await renderWithProviders(
      createElement(PrReviewInboxList, { header: null, recents: null })
    );
    onTestFinished(mounted.unmount);
    const buttons = () => hosts(mounted, 'Button');
    await waitFor(() => buttons().length === 1);
    mocks.providerPage.mockRejectedValue(new Error('GitLab unavailable'));
    await act(async () => {
      await mounted.queryClient.refetchQueries({ queryKey: ['provider-inbox'] });
    });
    await waitFor(() => buttons().length === 2);
    const retry = mounted.renderer.root.findByProps({ accessibilityLabel: 'Retry loading more' });
    mocks.providerPage.mockResolvedValue({ items: [gitlabItem], nextCursor: null });
    act(() => {
      (retry.props.onPress as () => void)();
    });
    await waitFor(() => hosts(mounted, 'Row').length === 1);
    expect(buttons()).toHaveLength(1);
    expect(mocks.githubPage).not.toHaveBeenCalled();
  });

  it.each(['disconnected', 'empty', 'rows'] as const)(
    'renders the existing reconnect action and recovers, GitLab=%s',
    async gitlab => {
      mocks.gitlabConnected = gitlab !== 'disconnected';
      const gitlabRowCount = gitlab === 'rows' ? 1 : 0;
      if (gitlab === 'empty') {
        mocks.providerPage.mockResolvedValue({ items: [], nextCursor: null });
      }
      mocks.authorization.mockResolvedValue({ connected: false, revoked: true });
      const mounted = await renderWithProviders(
        createElement(PrReviewInboxList, { header: null, recents: null })
      );
      onTestFinished(mounted.unmount);
      const buttons = () => hosts(mounted, 'Button');
      await waitFor(() => buttons().length > 0);
      expect(buttons()).toHaveLength(1);
      const check = mounted.renderer.root.findByProps({ accessibilityLabel: 'Check connection' });
      expect(hosts(mounted, 'EmptyState')).toHaveLength(0);
      expect(hosts(mounted, 'Row')).toHaveLength(gitlabRowCount);
      expect(mocks.githubPage).not.toHaveBeenCalled();
      mocks.providerPage.mockClear();
      act(() => {
        (check.props.onPress as () => void)();
      });
      await waitFor(() => mounted.queryClient.isMutating() === 0);
      expect(buttons()).toHaveLength(1);
      expect(mocks.githubPage).not.toHaveBeenCalled();
      mocks.authorization.mockResolvedValue({ connected: true, revoked: false });
      act(() => {
        (check.props.onPress as () => void)();
      });
      await waitFor(() => buttons().length === 0);
      await waitFor(() => hosts(mounted, 'Row').length === gitlabRowCount + 1);
      expect(mocks.githubPage).toHaveBeenCalledTimes(1);
      expect(mocks.providerPage).not.toHaveBeenCalled();
    }
  );
});
