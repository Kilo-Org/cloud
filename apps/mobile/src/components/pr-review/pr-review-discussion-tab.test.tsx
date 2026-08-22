/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewDiscussionTab } from './pr-review-discussion-tab';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

const discussionState = vi.hoisted(() => ({
  query: {
    isPending: false,
    isFetching: false,
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

function mountTab(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(PrReviewDiscussionTab, BASE_PROPS));
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
  discussionState.query.hasNextPage = false;
  discussionState.query.isFetchingNextPage = false;
  discussionState.threads = [];
  discussionState.conversation = [];
  discussionState.firstPageErrorState = null;
  discussionState.laterPageError = false;
}

describe('PrReviewDiscussionTab chrome bottom inset (plan §6)', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    resetState();
  });

  it('pads the permission chrome by the detail-screen padding at a zero inset', () => {
    discussionState.firstPageErrorState = { kind: 'permission' };
    const renderer = mountTab();

    expectSinglePadding(renderer, 32);
  });

  it('pads the not-found chrome by the detail-screen padding at a zero inset', () => {
    discussionState.firstPageErrorState = { kind: 'not-found' };
    const renderer = mountTab();

    expectSinglePadding(renderer, 32);
  });

  it('pads the reconnect chrome by the detail-screen padding at a zero inset', () => {
    discussionState.firstPageErrorState = { kind: 'reconnect' };
    const renderer = mountTab();

    expectSinglePadding(renderer, 32);
  });

  it('pads the retryable chrome by the detail-screen padding at a zero inset', () => {
    discussionState.firstPageErrorState = { kind: 'retryable' };
    const renderer = mountTab();

    expectSinglePadding(renderer, 32);
  });

  it('pads the loading chrome by the detail-screen padding at a zero inset', () => {
    discussionState.query.isPending = true;
    const renderer = mountTab();

    expectSinglePadding(renderer, 32);
  });

  it('pads the empty chrome by the detail-screen padding at a zero inset', () => {
    const renderer = mountTab();

    expectSinglePadding(renderer, 32);
  });

  it('grows every chrome padding with a nonzero system inset', () => {
    insetsState.bottom = 34;
    const states: { kind: string }[] = [
      { kind: 'permission' },
      { kind: 'not-found' },
      { kind: 'reconnect' },
      { kind: 'retryable' },
    ];
    for (const state of states) {
      resetState();
      discussionState.firstPageErrorState = state;
      const renderer = mountTab();
      // Math.max(34, 16) + 16
      expectSinglePadding(renderer, 50);
    }

    resetState();
    discussionState.query.isPending = true;
    expectSinglePadding(mountTab(), 50);

    resetState();
    expectSinglePadding(mountTab(), 50);
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
