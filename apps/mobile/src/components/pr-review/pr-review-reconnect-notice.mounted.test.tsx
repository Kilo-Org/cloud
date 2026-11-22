import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { QueryObserver } from '@tanstack/react-query';
import { act, type ComponentProps } from 'react';
import { type ProviderPrScope, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewReconnectNotice } from './pr-review-reconnect-notice';

type RouterOutputs = inferRouterOutputs<MobileRouter>;
type GitLabStatus = RouterOutputs['personalReviewAgent']['getGitLabStatus'];
type BitbucketReadiness = RouterOutputs['organizations']['reviewAgent']['getBitbucketReadiness'];

/**
 * The part of a status answer the connection check reads: the live flag and,
 * on GitLab, the instance that connection serves. The rest of the status is
 * the settings surface's, and an answer without it says nothing the check asks.
 */
type GitLabStatusAnswer = {
  connected: GitLabStatus['connected'];
  integration: Pick<NonNullable<GitLabStatus['integration']>, 'instanceUrl'> | null;
};
type BitbucketReadinessAnswer = Pick<BitbucketReadiness, 'connected'>;

const mocks = vi.hoisted(() => ({
  authorization: vi.fn<() => Promise<{ connected: boolean; revoked: boolean }>>(),
  review: vi.fn<() => Promise<string>>(),
  gitlabStatus: vi.fn<() => Promise<GitLabStatusAnswer>>(),
  bitbucketReadiness: vi.fn<() => Promise<BitbucketReadinessAnswer>>(),
  toastError: vi.fn(),
}));
const authorizationKey = ['githubApps', 'getUserAuthorization'];
const reviewKey = ['githubPrReview', 'getPullRequest'];
const gitlabStatusKey = ['personalReviewAgent', 'getGitLabStatus'];
const bitbucketReadinessKey = ['organizations', 'reviewAgent', 'getBitbucketReadiness'];

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // `Card` reaches `@/lib/utils` and therefore the app's i18n singleton, which
  // registers this plugin on load.
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: {
        queryOptions: () => ({
          queryKey: authorizationKey,
          queryFn: mocks.authorization,
          staleTime: Infinity,
        }),
      },
    },
    githubPrReview: { pathFilter: () => ({ queryKey: ['githubPrReview'] }) },
    // The provider arm is driven through the real check hook, so the mock
    // stands in for the status procedures rather than for the hook: the
    // comparison against the ref's instance runs in the component.
    personalReviewAgent: {
      getGitLabStatus: {
        queryOptions: () => ({ queryKey: gitlabStatusKey, queryFn: mocks.gitlabStatus }),
      },
    },
    organizations: {
      reviewAgent: {
        getBitbucketReadiness: {
          queryOptions: () => ({
            queryKey: bitbucketReadinessKey,
            queryFn: mocks.bitbucketReadiness,
          }),
        },
      },
    },
    providerReview: { pathFilter: () => ({ queryKey: ['providerReview'] }) },
  }),
}));

let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
let client = createTestQueryClient();
let unsubscribe: (() => void) | undefined = undefined;

beforeEach(() => {
  vi.clearAllMocks();
  client = createTestQueryClient();
  client.setQueryData(authorizationKey, { connected: true, revoked: false });
  mocks.authorization.mockResolvedValue({ connected: true, revoked: false });
  mocks.review.mockResolvedValue('recovered');
  mocks.gitlabStatus.mockResolvedValue({
    connected: true,
    integration: { instanceUrl: 'https://gitlab.com' },
  });
  mocks.bitbucketReadiness.mockResolvedValue({ connected: true });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  client.clear();
});

async function mountNotice(
  props: ComponentProps<typeof PrReviewReconnectNotice> = {},
  scope?: ProviderPrScope
): Promise<void> {
  const observer = new QueryObserver(client, {
    queryKey: reviewKey,
    queryFn: mocks.review,
    staleTime: Infinity,
    initialData: 'cached',
  });
  unsubscribe = observer.subscribe(vi.fn<() => void>());
  const notice = <PrReviewReconnectNotice {...props} />;
  view = await renderWithProviders(
    // A provider route publishes its scope above the notice; the GitHub route
    // publishes none, which is the mount every case above uses.
    scope ? <ProviderPrScopeProvider value={scope}>{notice}</ProviderPrScopeProvider> : notice,
    { queryClient: client }
  );
}

function button() {
  const result = view?.renderer.root.find(node => (node.type as string) === 'Button');
  if (!result) {
    throw new Error('Connection button not found');
  }
  return result.props as { onPress: () => void; loading: boolean };
}

async function checkConnection() {
  await act(async () => {
    button().onPress();
    await Promise.resolve();
  });
  await waitFor(() => !button().loading && client.isMutating() === 0);
}

describe('PrReviewReconnectNotice', () => {
  it('checks fresh authorization and refetches review queries when still connected', async () => {
    await mountNotice();
    await checkConnection();

    expect(mocks.authorization).toHaveBeenCalledOnce();
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(client.getQueryData(reviewKey)).toBe('recovered');
  });

  it('updates the authorization gate without retrying reviews when revoked', async () => {
    mocks.authorization.mockResolvedValue({ connected: false, revoked: true });
    await mountNotice();
    await checkConnection();

    expect(client.getQueryData(authorizationKey)).toEqual({ connected: false, revoked: true });
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('shows a failed connection check without retrying review queries', async () => {
    mocks.authorization.mockRejectedValue(new Error('Connection check failed'));
    await mountNotice();
    await checkConnection();

    expect(mocks.toastError).toHaveBeenCalledWith('Connection check failed');
    expect(mocks.review).not.toHaveBeenCalled();
  });

  it('shows progress until the connection check finishes', async () => {
    const authorization = Promise.withResolvers<{ connected: boolean; revoked: boolean }>();
    mocks.authorization.mockReturnValue(authorization.promise);
    await mountNotice();
    await act(async () => {
      button().onPress();
      await Promise.resolve();
    });
    await waitFor(() => button().loading);

    await act(async () => {
      authorization.resolve({ connected: true, revoked: false });
      await authorization.promise;
    });
    await waitFor(() => !button().loading);
    expect(mocks.review).toHaveBeenCalledOnce();
  });

  it('reports a check that settled on a usable connection', async () => {
    const onConnectionRestored = vi.fn<() => void>();
    await mountNotice({ onConnectionRestored });
    await checkConnection();

    // The answer is what a surface clears its own latch with, so it is
    // reported exactly once, after the check settled.
    expect(onConnectionRestored).toHaveBeenCalledOnce();
  });

  it('reports nothing when the check answers a revoked connection', async () => {
    mocks.authorization.mockResolvedValue({ connected: false, revoked: true });
    const onConnectionRestored = vi.fn<() => void>();
    await mountNotice({ onConnectionRestored });
    await checkConnection();

    expect(onConnectionRestored).not.toHaveBeenCalled();
  });

  it('reports nothing when the check rejects', async () => {
    mocks.authorization.mockRejectedValue(new Error('Connection check failed'));
    const onConnectionRestored = vi.fn<() => void>();
    await mountNotice({ onConnectionRestored });
    await checkConnection();

    // The hook's toast owns the failure; a surface must not read a failed
    // check as a resolved connection.
    expect(mocks.toastError).toHaveBeenCalledWith('Connection check failed');
    expect(onConnectionRestored).not.toHaveBeenCalled();
  });
});

const GITLAB_SAAS: ProviderPrScope = {
  ref: {
    platform: 'gitlab',
    projectPath: 'group/repo',
    mrIid: 18,
    instanceHint: 'https://gitlab.com',
  },
  organizationId: null,
};

const GITLAB_SELF_MANAGED: ProviderPrScope = {
  ref: {
    platform: 'gitlab',
    projectPath: 'group/repo',
    mrIid: 18,
    instanceHint: 'https://gitlab.example.com',
  },
  organizationId: null,
};

const BITBUCKET_ORG: ProviderPrScope = {
  ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 3 },
  organizationId: 'org_1',
};

/**
 * Mounts the notice under a provider route's scope, presses its own check and
 * returns the report spy. The route, not a prop, names the provider here: that
 * is the path a detail screen takes, and it is the one the instance comparison
 * reads the ref from.
 */
async function checkProviderConnection(scope: ProviderPrScope) {
  const onConnectionRestored = vi.fn<() => void>();
  await mountNotice({ onConnectionRestored }, scope);
  await checkConnection();
  return onConnectionRestored;
}

describe('PrReviewReconnectNotice — provider scope', () => {
  it('reports a GitLab connection that serves the merge request instance', async () => {
    const onConnectionRestored = await checkProviderConnection(GITLAB_SAAS);

    // The status read is the provider arm running at all: without it the
    // notice would still report, but on the GitHub authorization instead.
    expect(mocks.gitlabStatus).toHaveBeenCalledOnce();
    expect(onConnectionRestored).toHaveBeenCalledOnce();
  });

  it('reports nothing when the connected GitLab instance is another host', async () => {
    const onConnectionRestored = await checkProviderConnection(GITLAB_SELF_MANAGED);

    // The account is connected to gitlab.com while this merge request lives on
    // gitlab.example.com, so no read can succeed: the server refuses that hint
    // as not-found, and a surface that cleared its latch here would retry into
    // the same failure. Only the instance comparison stops the report.
    expect(mocks.gitlabStatus).toHaveBeenCalledOnce();
    expect(onConnectionRestored).not.toHaveBeenCalled();
  });

  it('reports nothing when GitLab answers not connected', async () => {
    mocks.gitlabStatus.mockResolvedValue({ connected: false, integration: null });
    const onConnectionRestored = await checkProviderConnection(GITLAB_SAAS);

    expect(mocks.gitlabStatus).toHaveBeenCalledOnce();
    expect(onConnectionRestored).not.toHaveBeenCalled();
  });

  it('reports nothing when the GitLab status read rejects', async () => {
    mocks.gitlabStatus.mockRejectedValue(new Error('Connection check failed'));
    const onConnectionRestored = await checkProviderConnection(GITLAB_SAAS);

    // The provider hook toasts its own failure, exactly as the GitHub arm does,
    // and a rejected check is never a resolved connection.
    expect(mocks.toastError).toHaveBeenCalledWith('Connection check failed');
    expect(onConnectionRestored).not.toHaveBeenCalled();
  });

  it('reports a connected Bitbucket organization — one host, nothing to compare', async () => {
    const onConnectionRestored = await checkProviderConnection(BITBUCKET_ORG);

    // Bitbucket Cloud is organization-context only and has a single host, so a
    // connected readiness answer is already able to serve the opened PR.
    expect(mocks.bitbucketReadiness).toHaveBeenCalledOnce();
    expect(onConnectionRestored).toHaveBeenCalledOnce();
  });
});
