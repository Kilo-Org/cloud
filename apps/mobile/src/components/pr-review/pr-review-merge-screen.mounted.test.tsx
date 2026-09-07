// The merge screen gates its sheet on the provider reads' SUCCESS (ux2): an
// errored `providerReview.getMergeState` must not mount the GitLab sheet
// without its restrictions list, and an errored `providerReview.getCapabilities`
// must not mount the Bitbucket auto-merge sheet without its capability banner.
// The failure body's Retry refetches the failed provider reads alongside the
// overview. Mounted with a keyed `useQuery` mock so each read can settle into a
// different state than its siblings.

import type * as ReactQuery from '@tanstack/react-query';
import { type ReactNode, createElement } from 'react';
import { type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrReviewMergeScreen } from './pr-review-merge-screen';
import { type ProviderPrScope, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { renderWithProviders } from '@/test/render-with-providers';

type MockQueryResult = {
  data: unknown;
  isLoading: boolean;
  isPending: boolean;
  isSuccess: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
};

type ResultKey = 'overview' | 'mergeState' | 'capabilities';

const mock = vi.hoisted(() => ({
  results: {} as Record<ResultKey, MockQueryResult>,
  params: {} as Record<string, string | string[]>,
  scope: null as ProviderPrScope | null,
}));

function mockResult(overrides: Partial<MockQueryResult> = {}): MockQueryResult {
  return {
    data: undefined,
    isLoading: false,
    isPending: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: vi.fn(async () => undefined),
    ...overrides,
  };
}

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQuery: (options: { queryKey: readonly unknown[] }) =>
    mock.results[String(options.queryKey[0]) as ResultKey],
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useLocalSearchParams: () => mock.params,
}));
vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
}));
vi.mock('@/components/pr-review/merge/pr-merge-sheet', () => ({
  PrMergeSheet: 'PrMergeSheet',
  providerPrNounKey: (platform: string) =>
    platform === 'gitlab' ? 'common.mergeRequest' : 'common.pullRequest',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {},
  useTRPC: () => ({
    githubPrReview: { getPullRequest: { queryOptions: () => ({ queryKey: ['overview'] }) } },
    providerReview: {
      getPullRequest: { queryOptions: () => ({ queryKey: ['overview'] }) },
      getMergeState: { queryOptions: () => ({ queryKey: ['mergeState'] }) },
      getCapabilities: { queryOptions: () => ({ queryKey: ['capabilities'] }) },
    },
  }),
}));

function ScopeWrapper({ children }: Readonly<{ children: ReactNode }>) {
  return createElement(ProviderPrScopeProvider, { value: mock.scope!, children });
}

const gitlabMergeState = {
  canMerge: false,
  approvalsRequired: 2,
  pipelineMustSucceed: true,
  conflicts: false,
  blockedReasons: [{ code: 'approvals', message: '2 approvals required' }],
};

const overviewData = {
  headSha: 'abc123',
  headRef: 'feature',
  isCrossRepo: false,
  prNodeId: 'gitlab:group/repo!12',
  title: 'Ship it',
  bodyMarkdown: '',
  baseRef: 'main',
  repo: { allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false },
};

const autoMergeUnsupported = { supported: false, reason: 'Workspace has no auto-merge' };

function gitlabMergeParams() {
  mock.params = { platform: 'gitlab', identity: ['group', 'repo', '12'] };
  mock.scope = {
    ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 12 },
    organizationId: null,
  };
}

function bitbucketAutoMergeParams() {
  mock.params = { platform: 'bitbucket', identity: ['ws', 'repo', '7'], mode: 'enable-auto-merge' };
  mock.scope = {
    ref: { platform: 'bitbucket', workspace: 'ws', repoSlug: 'repo', prId: 7 },
    organizationId: 'org-1',
  };
}

async function renderScreen() {
  return renderWithProviders(createElement(PrReviewMergeScreen), { wrapper: ScopeWrapper });
}

function findSheet(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'PrMergeSheet');
}

function findError(renderer: ReactTestRenderer) {
  return renderer.root.findAll(node => String(node.type) === 'QueryError');
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.results = {
    overview: mockResult({ data: overviewData }),
    mergeState: mockResult({ data: gitlabMergeState }),
    capabilities: mockResult({ data: { autoMerge: autoMergeUnsupported } }),
  };
});

describe('PrReviewMergeScreen provider-read gating', () => {
  it('keeps the GitLab sheet unmounted when getMergeState fails while the overview succeeds', async () => {
    gitlabMergeParams();
    mock.results.mergeState = mockResult({ data: undefined, isSuccess: false, isError: true });
    const { renderer, unmount } = await renderScreen();
    expect(findSheet(renderer)).toHaveLength(0);
    expect(findError(renderer)).toHaveLength(1);
    unmount();
  });

  it('refetches the failed merge-state read alongside the overview on Retry', async () => {
    gitlabMergeParams();
    mock.results.mergeState = mockResult({ data: undefined, isSuccess: false, isError: true });
    const { renderer, unmount } = await renderScreen();
    const error = findError(renderer)[0]!;
    (error.props.onRetry as () => void)();
    await vi.waitFor(() => {
      expect(mock.results.overview.refetch).toHaveBeenCalledOnce();
      expect(mock.results.mergeState.refetch).toHaveBeenCalledOnce();
    });
    expect(mock.results.capabilities.refetch).not.toHaveBeenCalled();
    unmount();
  });

  it('keeps the Bitbucket auto-merge sheet unmounted when getCapabilities fails', async () => {
    bitbucketAutoMergeParams();
    mock.results.mergeState = mockResult({ data: { ...gitlabMergeState, canMerge: true } });
    mock.results.capabilities = mockResult({ data: undefined, isSuccess: false, isError: true });
    const { renderer, unmount } = await renderScreen();
    expect(findSheet(renderer)).toHaveLength(0);
    expect(findError(renderer)).toHaveLength(1);
    const error = findError(renderer)[0]!;
    (error.props.onRetry as () => void)();
    await vi.waitFor(() => {
      expect(mock.results.overview.refetch).toHaveBeenCalledOnce();
      expect(mock.results.capabilities.refetch).toHaveBeenCalledOnce();
    });
    // The merge-state read succeeded, so Retry does not refetch it.
    expect(mock.results.mergeState.refetch).not.toHaveBeenCalled();
    unmount();
  });

  it('mounts the sheet with the restrictions list and the capability banner once both reads succeed', async () => {
    bitbucketAutoMergeParams();
    mock.results.mergeState = mockResult({ data: { ...gitlabMergeState, canMerge: true } });
    const { renderer, unmount } = await renderScreen();
    const sheets = findSheet(renderer);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]!.props.mergeState).toEqual({ ...gitlabMergeState, canMerge: true });
    expect(sheets[0]!.props.autoMergeCapability).toEqual(autoMergeUnsupported);
    expect(findError(renderer)).toHaveLength(0);
    unmount();
  });

  it('shows one loading body while the merge-state read is in flight, not a sheet without it', async () => {
    gitlabMergeParams();
    mock.results.mergeState = mockResult({
      data: undefined,
      isSuccess: false,
      isPending: true,
      isLoading: true,
    });
    const { renderer, unmount } = await renderScreen();
    expect(findSheet(renderer)).toHaveLength(0);
    expect(findError(renderer)).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(1);
    unmount();
  });
});
