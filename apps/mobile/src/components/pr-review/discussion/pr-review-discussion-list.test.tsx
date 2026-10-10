import { type ComponentProps, createElement, Fragment, type ReactElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ConversationComment,
  type DiscussionListItem,
  type ReviewThread,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { PrReviewDiscussionList } from './pr-review-discussion-list';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const flashListProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashListProps.current = props;
    const data = props.data as readonly unknown[];
    const renderItem = props.renderItem as (args: { item: unknown; index: number }) => ReactElement;
    return createElement(
      Fragment,
      null,
      data.map((item, index) =>
        createElement(Fragment, { key: index }, renderItem({ item, index }))
      ),
      props.ListFooterComponent as ReactElement
    );
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
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/icons', () => ({ MessageSquarePlus: 'MessageSquarePlus' }));
vi.mock('@/components/pr-review/discussion/comment-row', () => ({ CommentRow: 'CommentRow' }));
vi.mock('@/components/pr-review/discussion/discussion-thread', () => ({
  DiscussionThread: 'DiscussionThread',
}));

const BASE_PROPS: ComponentProps<typeof PrReviewDiscussionList> = {
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

function mountList(
  overrides: Partial<ComponentProps<typeof PrReviewDiscussionList>> = {}
): TestRenderer.ReactTestRenderer {
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
    node => typeof node.type === 'string' && (node.type as string) === 'View'
  );
  const footer = views[0];
  if (!footer) {
    throw new Error('footer View not found');
  }
  return footer;
}

describe('PrReviewDiscussionList side insets (landscape)', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
    flashListProps.current = null;
  });

  it('carries explicit zero side insets at portrait', () => {
    mountList();

    expect(flashListProps.current?.contentContainerStyle).toEqual({
      paddingTop: 12,
      paddingLeft: 0,
      paddingRight: 0,
    });
  });

  it('clears the sensor housing with the landscape side insets', () => {
    insetsState.left = 47;
    insetsState.right = 59;

    mountList();

    expect(flashListProps.current?.contentContainerStyle).toEqual({
      paddingTop: 12,
      paddingLeft: 47,
      paddingRight: 59,
    });
  });
});

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

// s4: the tab passes own-comment callbacks only on the GitHub write surface;
// this list binds a conversation row with kind 'conversation' and forwards the
// callbacks (bound per review comment inside the thread card) unchanged.
describe('PrReviewDiscussionList own-comment action binding (s4)', () => {
  const comment: ConversationComment = {
    commentId: 42,
    nodeId: 'c42',
    author: { login: 'octocat', avatarUrl: null },
    bodyMarkdown: 'the body',
    createdAt: '2026-01-01T00:00:00Z',
    reactions: [],
  };

  const thread: ReviewThread = {
    threadId: 't1',
    isResolved: false,
    isOutdated: false,
    subjectType: 'LINE',
    path: 'src/index.ts',
    line: 10,
    startLine: null,
    originalLine: null,
    originalStartLine: null,
    diffSide: 'RIGHT',
    diffHunk: null,
    comments: [
      {
        commentId: 7,
        nodeId: 'c7',
        author: { login: 'octocat', avatarUrl: null },
        bodyMarkdown: 'review body',
        createdAt: '2026-01-01T00:00:00Z',
        reactions: [],
      },
    ],
  };

  const items: readonly DiscussionListItem[] = [
    { kind: 'comment', comment },
    { kind: 'thread', thread },
  ];

  beforeEach(() => {
    flashListProps.current = null;
  });

  it('binds a conversation row with kind conversation and hands it the comment', () => {
    const onEditComment = vi.fn<(comment: unknown, kind: unknown) => void>();
    const onDeleteComment = vi.fn<(comment: unknown, kind: unknown) => void>();
    const renderer = mountList({ listItems: items, onEditComment, onDeleteComment });

    const row = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'CommentRow'
    );
    (row.props.onEditComment as () => void)();
    (row.props.onDeleteComment as () => void)();

    expect(onEditComment).toHaveBeenCalledTimes(1);
    expect(onEditComment).toHaveBeenCalledWith(comment, 'conversation');
    expect(onDeleteComment).toHaveBeenCalledTimes(1);
    expect(onDeleteComment).toHaveBeenCalledWith(comment, 'conversation');

    renderer.unmount();
  });

  it('forwards the callbacks unchanged to the thread card', () => {
    const onEditComment = vi.fn<(comment: unknown, kind: unknown) => void>();
    const onDeleteComment = vi.fn<(comment: unknown, kind: unknown) => void>();
    const renderer = mountList({ listItems: items, onEditComment, onDeleteComment });

    const threadCard = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'DiscussionThread'
    );
    expect(threadCard.props.onEditComment).toBe(onEditComment);
    expect(threadCard.props.onDeleteComment).toBe(onDeleteComment);

    renderer.unmount();
  });

  it('leaves both rows without callbacks when none are passed (provider scope)', () => {
    const renderer = mountList({ listItems: items });

    const row = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'CommentRow'
    );
    const threadCard = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'DiscussionThread'
    );
    expect(row.props.onEditComment).toBeUndefined();
    expect(row.props.onDeleteComment).toBeUndefined();
    expect(threadCard.props.onEditComment).toBeUndefined();
    expect(threadCard.props.onDeleteComment).toBeUndefined();

    renderer.unmount();
  });
});
