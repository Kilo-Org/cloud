import { createElement, Fragment, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type DiscussionListItem } from '@/lib/pr-review/discussion/review-discussion-types';
import { ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { PrReviewDiscussionList } from './pr-review-discussion-list';

type TaggedOptions = { tag: string; input?: unknown };

const observed = vi.hoisted(() => ({ options: [] as TaggedOptions[] }));
const moderation = vi.hoisted(() => ({
  blockedLogins: [] as string[],
  mutedLogins: [] as string[],
}));

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
      return {
        data: { blockedLogins: moderation.blockedLogins, mutedLogins: moderation.mutedLogins },
      };
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
  }: {
    data: readonly unknown[];
    renderItem: (args: { item: unknown; index: number }) => ReactNode;
  }) =>
    createElement(
      Fragment,
      null,
      data.map((item, index) =>
        createElement(Fragment, { key: index }, renderItem({ item, index }))
      )
    ),
}));
vi.mock('@/components/pr-review/discussion/comment-row', () => ({ CommentRow: 'CommentRow' }));
vi.mock('@/components/pr-review/discussion/discussion-thread', () => ({
  DiscussionThread: 'DiscussionThread',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/screen-insets', () => ({ useDetailScreenBottomPadding: () => 0 }));

function noop(): void {
  // The viewer query is what this file asserts; the list callbacks are inert.
}

const listItems: readonly DiscussionListItem[] = [
  {
    kind: 'comment',
    comment: {
      commentId: 1,
      nodeId: 'c1',
      author: { login: 'octocat', avatarUrl: null },
      bodyMarkdown: 'hello',
      createdAt: '2026-01-01T00:00:00Z',
      reactions: [],
    },
  },
];

function mountList(
  scope?: {
    ref: { platform: 'gitlab'; projectPath: string; mrIid: number };
    organizationId: string | null;
  },
  overrides: Partial<Parameters<typeof PrReviewDiscussionList>[0]> = {}
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

describe('PrReviewDiscussionList viewer query', () => {
  beforeEach(() => {
    observed.options = [];
  });

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
