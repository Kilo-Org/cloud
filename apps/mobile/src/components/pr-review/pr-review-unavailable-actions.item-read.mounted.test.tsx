import { type ProviderPrSummary } from '@kilocode/app-shared/provider-review';
import { useQuery } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { buildPrOverviewQueryOptions } from '@/lib/pr-review/provider-pr-queries';
import { type ProviderPrScope, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { useTRPC } from '@/lib/trpc';
import {
  createTestQueryClient,
  renderWithProviders,
  type RenderWithProvidersResult,
  waitFor,
} from '@/test/render-with-providers';
import { PrReviewUnavailableActions } from './pr-review-unavailable-actions';

// The real connection hook runs here: it force-refetches the provider status,
// then invalidates every `providerReview` read and waits for the refetch. The
// two reads below stand in for the server, so the check's own continuation is
// what the assertions observe.
const reads = vi.hoisted(() => ({ item: vi.fn(), status: vi.fn() }));
const toastMock = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    providerReview: {
      getPullRequest: {
        queryOptions: (input: unknown, options: Record<string, unknown> = {}) => ({
          queryKey: [['providerReview', 'getPullRequest'], { input, type: 'query' }],
          queryFn: reads.item,
          ...options,
        }),
      },
      pathFilter: () => ({ queryKey: [['providerReview']] }),
    },
    personalReviewAgent: {
      getGitLabStatus: {
        queryOptions: () => ({
          queryKey: ['personalReviewAgent', 'getGitLabStatus'],
          queryFn: reads.status,
        }),
      },
    },
  }),
}));
vi.mock('sonner-native', () => ({ toast: toastMock }));
vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

const SCOPE: ProviderPrScope = {
  ref: {
    platform: 'gitlab',
    projectPath: 'group/repo',
    mrIid: 18,
    instanceHint: 'https://gitlab.com',
  },
  organizationId: null,
};

const SUMMARY: ProviderPrSummary = {
  ref: SCOPE.ref,
  title: 'Add a preview step',
  body: null,
  author: { login: 'author', avatarUrl: null },
  state: 'open',
  draft: false,
  headRef: 'feature/preview',
  baseRef: 'main',
  headSha: 'a'.repeat(40),
  changedFiles: 2,
  additions: 12,
  deletions: 3,
  webUrl: 'https://gitlab.com/group/repo/-/merge_requests/18',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

type Mounted = RenderWithProvidersResult;

/** The review read the unavailable surface rendered, mounted for real. */
function ItemRead() {
  const trpc = useTRPC();
  useQuery(buildPrOverviewQueryOptions(trpc, SCOPE));
  return null;
}

function Surface() {
  return (
    <ProviderPrScopeProvider value={SCOPE}>
      <PrReviewUnavailableActions onRetry={() => undefined} isRetrying={false} />
    </ProviderPrScopeProvider>
  );
}

function mountSurface(queryClient = createTestQueryClient()): Promise<Mounted> {
  return renderWithProviders(
    <>
      <ItemRead />
      <Surface />
    </>,
    { queryClient }
  );
}

/** The item read's cache entry, which is what the surface and the toast share. */
function itemQuery(queryClient: Mounted['queryClient']) {
  return queryClient.getQueryCache().findAll({ queryKey: [['providerReview']] })[0];
}

type ButtonInstance = {
  props: {
    onPress: () => void;
    children: { props: { children: string } };
  };
};

function findButtons(renderer: { root: { findAll: (f: (n: unknown) => boolean) => unknown[] } }) {
  return renderer.root.findAll(
    node => String((node as { type: unknown }).type) === 'Button'
  ) as ButtonInstance[];
}

async function pressCheckConnection(mounted: Mounted) {
  const check = findButtons(mounted.renderer)[1];
  if (!check) {
    throw new Error('the connection check button did not render');
  }
  check.props.onPress();
  // One macrotask turn so the check's own promise chain can start.
  await waitFor(() => true);
}

beforeEach(() => {
  reads.item.mockReset();
  reads.status.mockReset().mockResolvedValue({
    connected: true,
    integration: { instanceUrl: 'https://gitlab.com' },
  });
  toastMock.mockClear();
  toastMock.error.mockClear();
});

describe('PrReviewUnavailableActions — the check reads the refetched item', () => {
  it('stays silent when the refetched read loads the item the reader now sees', async () => {
    reads.item.mockRejectedValue(new Error('Not found'));
    const mounted = await mountSurface();
    await waitFor(() => itemQuery(mounted.queryClient)?.state.status === 'error');

    reads.item.mockResolvedValue(SUMMARY);
    await pressCheckConnection(mounted);
    await waitFor(() => itemQuery(mounted.queryClient)?.state.data !== undefined);

    expect(reads.item).toHaveBeenCalledTimes(2);
    expect(toastMock).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('reports the active connection when the refetched read still finds nothing', async () => {
    reads.item.mockRejectedValue(new Error('Not found'));
    const mounted = await mountSurface();
    await waitFor(() => itemQuery(mounted.queryClient)?.state.status === 'error');

    await pressCheckConnection(mounted);
    await waitFor(() => reads.item.mock.calls.length === 2);
    await waitFor(() => toastMock.mock.calls.length > 0);

    expect(toastMock).toHaveBeenCalledExactlyOnceWith(
      "Connection is active, but this item still can't be loaded."
    );
    mounted.unmount();
  });

  it('reports it when the read fails again although an earlier load cached data', async () => {
    // The item was read successfully before, so the cache still holds it while
    // this surface shows the failure. Cached data is not the refreshed answer.
    reads.item.mockResolvedValue(SUMMARY);
    const mounted = await mountSurface();
    await waitFor(() => itemQuery(mounted.queryClient)?.state.status === 'success');

    reads.item.mockRejectedValue(new Error('Not found'));
    await mounted.queryClient.refetchQueries({ queryKey: [['providerReview']] });
    await waitFor(() => itemQuery(mounted.queryClient)?.state.status === 'error');
    expect(itemQuery(mounted.queryClient)?.state.data).toEqual(
      expect.objectContaining({ title: 'Add a preview step' })
    );

    await pressCheckConnection(mounted);
    await waitFor(() => reads.item.mock.calls.length === 3);
    await waitFor(() => toastMock.mock.calls.length > 0);

    expect(toastMock).toHaveBeenCalledExactlyOnceWith(
      "Connection is active, but this item still can't be loaded."
    );
    mounted.unmount();
  });
});
