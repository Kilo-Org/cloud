/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ProviderPrRef, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';

import { PrReviewDiscussionTab } from './pr-review-discussion-tab';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

const discussionState = vi.hoisted(() => ({
  query: {
    isPending: false,
    isFetching: false,
    isPaused: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  },
  threads: [] as unknown[],
  conversation: [] as unknown[],
  firstPageErrorState: null as { kind: string } | null,
  laterPageError: false,
}));

vi.mock('react-native', () => ({
  View: 'View',
  Platform: { OS: 'ios' },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
vi.mock('@/lib/pr-review/discussion/use-pr-review-discussion-threads', () => ({
  usePrReviewDiscussionThreads: () => discussionState,
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ scrollAnimated: false }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ MessageSquarePlus: 'MessageSquarePlus' }));
vi.mock('@/components/pr-review/discussion/pr-review-discussion-list', () => ({
  PrReviewDiscussionList: 'PrReviewDiscussionList',
}));

const BASE_PROPS = {
  owner: 'octocat',
  repo: 'hello-world',
  number: 7,
  onRequestFiles: vi.fn(() => undefined),
};

/** Mounts the tab, optionally under a provider scope (no scope = GitHub). */
function mountTab(scopeRef?: ProviderPrRef): TestRenderer.ReactTestRenderer {
  const tab = createElement(PrReviewDiscussionTab, BASE_PROPS);
  const tree = scopeRef ? (
    <ProviderPrScopeProvider value={{ ref: scopeRef, organizationId: null }}>
      {tab}
    </ProviderPrScopeProvider>
  ) : (
    tab
  );
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(tree);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function bottomPaddedViews(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.style != null &&
      typeof node.props.style === 'object' &&
      'paddingBottom' in (node.props.style as Record<string, unknown>)
  );
}

function expectSinglePadding(renderer: TestRenderer.ReactTestRenderer, expected: number): void {
  const views = bottomPaddedViews(renderer);
  expect(views).toHaveLength(1);
  const view = views[0];
  if (!view) {
    throw new Error('expected a padded View');
  }
  expect((view.props.style as { paddingBottom?: number }).paddingBottom).toBe(expected);
}

function resetState(): void {
  discussionState.query.isPending = false;
  discussionState.query.isFetching = false;
  discussionState.query.isPaused = false;
  discussionState.query.hasNextPage = false;
  discussionState.query.isFetchingNextPage = false;
  discussionState.threads = [];
  discussionState.conversation = [];
  discussionState.firstPageErrorState = null;
  discussionState.laterPageError = false;
}

describe('PrReviewDiscussionTab full-body states', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    resetState();
  });

  it.each(['permission', 'not-found', 'retryable'])('lets QueryError own the %s body', kind => {
    discussionState.firstPageErrorState = { kind };
    const renderer = mountTab();
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect(error.props.placement).toBeUndefined();
    expect(bottomPaddedViews(renderer)).toHaveLength(0);
    if (kind === 'retryable') {
      act(() => {
        (error.props.onRetry as () => void)();
      });
      expect(discussionState.query.refetch).toHaveBeenCalled();
    } else {
      expect(error.props.onRetry).toBeUndefined();
    }
  });

  it('centers the reconnect notice', () => {
    discussionState.firstPageErrorState = { kind: 'reconnect' };
    const renderer = mountTab();
    const centered = renderer.root.find(node => String(node.type) === 'CenteredState');
    expect(centered.find(node => String(node.type) === 'PrReviewReconnectNotice')).toBeDefined();
    expect(bottomPaddedViews(renderer)).toHaveLength(0);
  });

  it('keeps the loading skeleton padding', () => {
    discussionState.query.isPending = true;
    expectSinglePadding(mountTab(), 32);
  });

  it('escapes a stuck skeleton when the first page is paused, not in flight', () => {
    // Spot check e7: the tab showed only skeleton cards — no comments, no
    // empty state, no error. A pending page whose fetch is paused has no
    // end, so the tab must render the retryable state with a working Retry
    // CTA instead of the permanent skeleton.
    discussionState.query.isPending = true;
    discussionState.query.isPaused = true;
    const renderer = mountTab();

    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton')).toHaveLength(0);
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    act(() => {
      (error.props.onRetry as () => void)();
    });
    expect(discussionState.query.refetch).toHaveBeenCalled();
  });

  it('lets EmptyState own the empty body and keeps its Files action', () => {
    const renderer = mountTab();
    const empty = renderer.root.find(node => String(node.type) === 'EmptyState');
    expect(empty.props.placement).toBeUndefined();
    expect((empty.props.action as React.ReactElement<{ onPress: () => void }>).props.onPress).toBe(
      BASE_PROPS.onRequestFiles
    );
    expect(bottomPaddedViews(renderer)).toHaveLength(0);
  });

  it('keeps retained comments and a retry action after a transient first-page failure', () => {
    discussionState.conversation = [{ nodeId: 'c1', createdAt: null }];
    discussionState.firstPageErrorState = { kind: 'retryable' };
    const renderer = mountTab();
    const list = renderer.root.find(node => String(node.type) === 'PrReviewDiscussionList');
    expect(list.props.laterPageError).toBe(true);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
  });

  it('keeps permission denial ahead of retained comments', () => {
    discussionState.conversation = [{ nodeId: 'c1', createdAt: null }];
    discussionState.firstPageErrorState = { kind: 'permission' };
    const renderer = mountTab();
    expect(renderer.root.find(node => String(node.type) === 'QueryError').props.variant).toBe(
      'permission'
    );
    expect(
      renderer.root.findAll(node => String(node.type) === 'PrReviewDiscussionList')
    ).toHaveLength(0);
  });

  // Wording, not layout: the same three states below must never call a GitLab
  // merge request a "pull request". Every other state's copy is already
  // provider-neutral, so it stays on one key.
  const GITLAB_REF: ProviderPrRef = {
    platform: 'gitlab',
    projectPath: 'group/sub/repo',
    mrIid: 12,
  };

  function errorMessage(scopeRef?: ProviderPrRef): unknown {
    return mountTab(scopeRef).root.find(node => String(node.type) === 'QueryError').props.message;
  }

  it.each(['permission', 'not-found'])('names a merge request in the %s copy', kind => {
    discussionState.firstPageErrorState = { kind };
    expect(errorMessage(GITLAB_REF)).toContain('merge request');
    expect(errorMessage(GITLAB_REF)).not.toContain('pull request');
  });

  it.each(['permission', 'not-found'])(
    'keeps the pull request copy on the %s state without a provider scope',
    kind => {
      discussionState.firstPageErrorState = { kind };
      expect(errorMessage()).not.toContain('merge request');
    }
  );

  it('names a merge request in the empty state description', () => {
    const description = (scopeRef?: ProviderPrRef) =>
      mountTab(scopeRef).root.find(node => String(node.type) === 'EmptyState').props
        .description as string;
    expect(description(GITLAB_REF)).toContain('merge request');
    expect(description()).toContain('pull request');
  });

  it('renders the happy list without a chrome wrapper', () => {
    discussionState.conversation = [{ nodeId: 'c1', createdAt: null }];
    const renderer = mountTab();

    expect(bottomPaddedViews(renderer)).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'PrReviewDiscussionList'
      )
    ).toHaveLength(1);
  });
});
