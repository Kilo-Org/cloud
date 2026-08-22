/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement, Fragment, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewDiscussionList } from './pr-review-discussion-list';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const flashListProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashListProps.current = props;
    return createElement(Fragment, null, props.ListFooterComponent as ReactElement);
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
}));
vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: { listHiddenUsers: { queryOptions: () => ({}) } },
    githubPrReview: { getPullRequest: { queryOptions: () => ({}) } },
  }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/discussion/comment-row', () => ({ CommentRow: 'CommentRow' }));
vi.mock('@/components/pr-review/discussion/discussion-thread', () => ({
  DiscussionThread: 'DiscussionThread',
}));

const BASE_PROPS = {
  owner: 'octocat',
  repo: 'hello-world',
  number: 7,
  listItems: [],
  listRef: { current: null },
  expansion: {},
  suppressContentPosition: false,
  onToggleExpand: vi.fn(() => undefined),
  onScrollBeginDrag: vi.fn(() => undefined),
  hasNextPage: false,
  isFetchingNextPage: false,
  laterPageError: false,
  onLoadMore: vi.fn(() => undefined),
  onRetryLoadMore: vi.fn(() => undefined),
};

function mountList(overrides: Partial<typeof BASE_PROPS> = {}): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(PrReviewDiscussionList, { ...BASE_PROPS, ...overrides })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function footerView(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  const views = renderer.root.findAll(
    node => typeof node.type === 'string' && node.type === 'View'
  );
  const footer = views[0];
  if (!footer) {
    throw new Error('footer View not found');
  }
  return footer;
}

describe('PrReviewDiscussionList footer bottom inset (plan §6)', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    flashListProps.current = null;
  });

  it('pads the load-more footer by the detail-screen padding at a zero inset', () => {
    const renderer = mountList({ hasNextPage: true });

    const style = footerView(renderer).props.style as { paddingBottom?: number };
    expect(style.paddingBottom).toBe(32);
  });

  it('clears the last row with a height spacer at a zero inset', () => {
    const renderer = mountList({ hasNextPage: false });

    const style = footerView(renderer).props.style as { height?: number };
    expect(style.height).toBe(32);
  });

  it('pads the later-page error footer by the detail-screen padding at a zero inset', () => {
    const renderer = mountList({ laterPageError: true });

    const style = footerView(renderer).props.style as { paddingBottom?: number };
    expect(style.paddingBottom).toBe(32);
  });

  it('grows the footer clearance with a nonzero system inset', () => {
    insetsState.bottom = 34;

    const loadMore = mountList({ hasNextPage: true });
    expect((footerView(loadMore).props.style as { paddingBottom?: number }).paddingBottom).toBe(50);

    const lastRow = mountList({ hasNextPage: false });
    expect((footerView(lastRow).props.style as { height?: number }).height).toBe(50);

    const laterError = mountList({ laterPageError: true });
    expect((footerView(laterError).props.style as { paddingBottom?: number }).paddingBottom).toBe(
      50
    );
  });
});
