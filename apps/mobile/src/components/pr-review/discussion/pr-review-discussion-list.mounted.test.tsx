/* eslint-disable max-lines -- one cohesive list suite: the viewer-query and hidden-author cases share the same list mock harness, and both empty-state paths (the tab's `emptyState` prop and the list's own fallback) need their own cases. */
import { type ComponentProps, createElement, Fragment, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ConversationComment,
  type DiscussionListItem,
  type ReviewThread,
} from '@/lib/pr-review/discussion/review-discussion-types';
import { ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { PrReviewDiscussionList } from './pr-review-discussion-list';

type TaggedOptions = { tag: string; input?: unknown };

const observed = vi.hoisted(() => ({
  options: [] as TaggedOptions[],
  blockedLogins: [] as string[],
  mutedLogins: [] as string[],
}));

// The hidden-author suites drive the same hoisted fixtures under this name, so
// the mocked moderation query answers whichever name a test set state on.
const moderation = observed;

// Records every query the list mounts and answers the overview with a viewer
// login, so a test can assert BOTH which namespace was asked and what the
// answer drives.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: TaggedOptions) => {
    observed.options.push(options);
    if (options.tag === 'moderation') {
      return { data: { blockedLogins: observed.blockedLogins, mutedLogins: observed.mutedLogins } };
    }
    return { data: { repo: { viewerLogin: 'octocat' } } };
  },
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: { listHiddenUsers: { queryOptions: () => ({ tag: 'moderation' }) } },
    githubPrReview: {
      getPullRequest: {
        queryOptions: (input: unknown) => ({ tag: 'githubPrReview.getPullRequest', input }),
      },
    },
    providerReview: {
      getPullRequest: {
        queryOptions: (input: unknown) => ({ tag: 'providerReview.getPullRequest', input }),
      },
    },
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListEmptyComponent,
    ListFooterComponent,
  }: {
    data: readonly unknown[];
    renderItem: (args: { item: unknown; index: number }) => ReactNode;
    ListEmptyComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) =>
    createElement(
      Fragment,
      null,
      data.length === 0
        ? ListEmptyComponent
        : data.map((item, index) =>
            createElement(Fragment, { key: index }, renderItem({ item, index }))
          ),
      ListFooterComponent
    ),
}));
vi.mock('@/components/pr-review/discussion/comment-row', () => ({ CommentRow: 'CommentRow' }));
vi.mock('@/components/pr-review/discussion/discussion-thread', () => ({
  DiscussionThread: 'DiscussionThread',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/icons', () => ({ MessageSquarePlus: 'MessageSquarePlus' }));
vi.mock('@/lib/screen-insets', () => ({ useDetailScreenBottomPadding: () => 0 }));

function noop(): void {
  // Callbacks not exercised by a test are inert.
}

function makeComment(id: number, login: string | null = 'octocat'): ConversationComment {
  return {
    commentId: id,
    nodeId: `c${id}`,
    author: login === null ? null : { login, avatarUrl: null },
    bodyMarkdown: 'hello',
    createdAt: '2026-01-01T00:00:00Z',
    reactions: [],
  };
}

function makeThread(comments: ReviewThread['comments']): DiscussionListItem {
  return {
    kind: 'thread',
    thread: {
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
      comments,
    },
  };
}

const listItems: readonly DiscussionListItem[] = [{ kind: 'comment', comment: makeComment(1) }];

function mountList(
  scope?: {
    ref: { platform: 'gitlab'; projectPath: string; mrIid: number };
    organizationId: string | null;
  },
  overrides: Partial<ComponentProps<typeof PrReviewDiscussionList>> = {}
) {
  const list = (
    <PrReviewDiscussionList
      owner="group/sub"
      repo="repo"
      number={12}
      listItems={listItems}
      listRef={{ current: null }}
      expansion={{}}
      suppressContentPosition={false}
      onToggleExpand={noop}
      onScrollBeginDrag={noop}
      hasNextPage={false}
      isFetchingNextPage={false}
      laterPageError={false}
      onLoadMore={noop}
      onRetryLoadMore={noop}
      {...overrides}
    />
  );
  const created: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    created.current = TestRenderer.create(
      scope ? <ProviderPrScopeProvider value={scope}>{list}</ProviderPrScopeProvider> : list
    );
  });
  const renderer = created.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('PrReviewDiscussionList visible content', () => {
  beforeEach(() => {
    observed.options = [];
    observed.blockedLogins = [];
    observed.mutedLogins = [];
  });

  it.each(['blockedLogins', 'mutedLogins'] as const)(
    'explains an empty visible discussion when every author is in %s',
    hiddenUsers => {
      observed[hiddenUsers] = ['OCTOCAT'];
      const renderer = mountList(undefined, {
        listItems: Array.from({ length: 5 }, (_, index) => ({
          kind: 'comment',
          comment: makeComment(index + 1),
        })),
      });

      expect(renderer.root.findAll(node => String(node.type) === 'CommentRow')).toHaveLength(0);
      const emptyStates = renderer.root.findAll(node => String(node.type) === 'EmptyState');
      expect(emptyStates).toHaveLength(1);
      expect(emptyStates[0]?.props.title).toBe('prReview.discussion.noDiscussion');
      expect(emptyStates[0]?.props.description).toBe('prReview.discussion.noDiscussionDescription');
      // The FlashList owns scrolling; do not nest the centered state's ScrollView.
      expect(emptyStates[0]?.props.placement).toBe('top');
      // The same empty state names a merge request under a GitLab scope.
      const gitlab = mountList(
        {
          ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
          organizationId: null,
        },
        { listItems: [{ kind: 'comment', comment: makeComment(1) }] }
      );
      expect(gitlab.root.findByType('EmptyState').props.description).toBe(
        'prReview.terms.noDiscussionDescription'
      );
      gitlab.unmount();

      renderer.unmount();
    }
  );

  it.each([{ comments: [] }, { comments: [makeComment(1)] }])(
    'explains threads with no visible comments ($comments)',
    ({ comments }) => {
      observed.blockedLogins = ['octocat'];
      const renderer = mountList(undefined, { listItems: [makeThread(comments)] });
      expect(renderer.root.findAllByType('DiscussionThread')).toHaveLength(0);
      expect(renderer.root.findAllByType('EmptyState')).toHaveLength(1);
      renderer.unmount();
    }
  );

  it('keeps visible replies and deleted-author comments without an empty state', () => {
    observed.mutedLogins = ['octocat'];
    const visibleReply = makeComment(2, 'alice');
    const renderer = mountList(undefined, {
      listItems: [
        ...listItems,
        { kind: 'comment', comment: makeComment(3, null) },
        makeThread([makeComment(1), visibleReply]),
      ],
    });
    expect(renderer.root.findAllByType('CommentRow')).toHaveLength(1);
    expect(renderer.root.findByType('DiscussionThread').props.thread).toMatchObject({
      comments: [visibleReply],
    });
    expect(renderer.root.findAllByType('EmptyState')).toHaveLength(0);
    renderer.unmount();
  });

  it.each(['load-more', 'loading', 'retry'] as const)(
    'keeps the %s footer usable when all loaded comments are hidden',
    state => {
      observed.mutedLogins = ['octocat'];
      const onLoadMore = vi.fn<() => void>();
      const onRetryLoadMore = vi.fn<() => void>();
      const renderer = mountList(undefined, {
        hasNextPage: true,
        isFetchingNextPage: state === 'loading',
        laterPageError: state === 'retry',
        onLoadMore,
        onRetryLoadMore,
      });
      expect(renderer.root.findAllByType('EmptyState')).toHaveLength(1);
      const button = renderer.root.findByType('Button');
      if (state === 'loading') {
        expect(button.props.loading).toBe(true);
      } else {
        act(() => {
          (button.props.onPress as () => void)();
        });
        expect(state === 'retry' ? onRetryLoadMore : onLoadMore).toHaveBeenCalledOnce();
      }
      // A later page can reveal a visible comment without remounting the list surface.
      const props = renderer.root.findByType(PrReviewDiscussionList).props as ComponentProps<
        typeof PrReviewDiscussionList
      >;
      act(() => {
        renderer.update(
          <PrReviewDiscussionList
            {...props}
            listItems={[...listItems, { kind: 'comment', comment: makeComment(2, 'alice') }]}
            isFetchingNextPage={false}
            laterPageError={false}
          />
        );
      });
      expect(renderer.root.findAllByType('EmptyState')).toHaveLength(0);
      expect(renderer.root.findAllByType('CommentRow')).toHaveLength(1);
      renderer.unmount();
    }
  );

  it('reads the viewer login from the GitHub procedure on a GitHub scope', () => {
    const renderer = mountList();

    expect(observed.options.map(options => options.tag)).toEqual([
      'moderation',
      'githubPrReview.getPullRequest',
    ]);
    expect(observed.options[1]?.input).toEqual({ owner: 'group/sub', repo: 'repo', number: 12 });
    expect(
      renderer.root.findAll(node => String(node.type) === 'CommentRow')[0]?.props.viewerLogin
    ).toBe('octocat');
    expect(renderer.root.findAllByType('EmptyState')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('passes the provider triple and the conversation kind to each comment row', () => {
    const renderer = mountList();

    const row = renderer.root.findAll(node => String(node.type) === 'CommentRow')[0];
    expect(row?.props).toMatchObject({
      owner: 'group/sub',
      repo: 'repo',
      number: 12,
      commentKind: 'conversation',
      comment: { commentId: 1 },
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('never fires the GitHub procedure under a GitLab scope', () => {
    const renderer = mountList({
      ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
      organizationId: null,
    });

    expect(observed.options.map(options => options.tag)).toEqual([
      'moderation',
      'providerReview.getPullRequest',
    ]);
    expect(observed.options[1]?.input).toMatchObject({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
    });

    act(() => {
      renderer.unmount();
    });
  });
});

describe('PrReviewDiscussionList hidden-author filtering', () => {
  beforeEach(() => {
    moderation.blockedLogins = [];
    moderation.mutedLogins = [];
  });

  it('renders the tab empty state, not the rows, when every author is hidden', () => {
    moderation.blockedLogins = ['octocat'];

    const renderer = mountList(undefined, { emptyState: createElement('EmptyStateMarker') });

    expect(renderer.root.findAll(node => String(node.type) === 'CommentRow')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyStateMarker')).toHaveLength(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the load-more footer reachable under the filtered-empty state', () => {
    moderation.blockedLogins = ['octocat'];

    const renderer = mountList(undefined, {
      emptyState: createElement('EmptyStateMarker'),
      hasNextPage: true,
    });

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyStateMarker')).toHaveLength(1);
    expect(
      renderer.root
        .findAll(node => String(node.type) === 'Button')
        .map(button => button.props.accessibilityLabel)
    ).toContain('prReview.discussion.loadMoreComments');

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the later-page retry reachable under the filtered-empty state', () => {
    moderation.mutedLogins = ['octocat'];

    const renderer = mountList(undefined, {
      emptyState: createElement('EmptyStateMarker'),
      laterPageError: true,
    });

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyStateMarker')).toHaveLength(1);
    expect(
      renderer.root
        .findAll(node => String(node.type) === 'Button')
        .map(button => button.props.accessibilityLabel)
    ).toContain('prReview.discussion.retryLoadingMore');

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the rows and drops the empty state when the author is visible', () => {
    const renderer = mountList(undefined, { emptyState: createElement('EmptyStateMarker') });

    expect(renderer.root.findAll(node => String(node.type) === 'CommentRow')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyStateMarker')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders no copy of its own when no empty state was handed down', () => {
    moderation.blockedLogins = ['octocat'];

    const renderer = mountList();

    // The copy belongs to the tab; the list never invents a message. With no
    // empty state to fall back to, it keeps the list contract (here: no rows).
    expect(renderer.root.findAll(node => String(node.type) === 'CommentRow')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyStateMarker')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });
});
