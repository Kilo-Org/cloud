/* eslint-disable max-lines -- one suite for the tab's body states, the provider CTA sheet routing, and the keyboard-lift wiring */
// The module-mock harness and render helpers live in
// pr-review-discussion-tab.test-helpers. That import MUST stay first: the
// helpers register the module mocks while they are evaluated.
import {
  BASE_PROPS,
  bottomPaddedViews,
  discussionState,
  expectCtaPresence,
  focusState,
  insetsState,
  mountTab,
  pushMock,
  replyScrollFns,
  resetState,
} from './pr-review-discussion-tab.test-helpers';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';

beforeEach(() => {
  insetsState.bottom = 0;
  insetsState.left = 0;
  insetsState.right = 0;
  vi.clearAllMocks();
  resetState();
});

describe('PrReviewDiscussionTab loading skeleton side insets (landscape)', () => {
  function loadingWrapperStyle(): Record<string, number | undefined> {
    discussionState.query.isPending = true;
    const renderer = mountTab();
    // The loading skeleton never renders the comment CTA bar.
    expectCtaPresence(renderer, false);
    const views = bottomPaddedViews(renderer);
    expect(views).toHaveLength(1);
    const view = views[0];
    if (!view) {
      throw new Error('expected a padded View');
    }
    return view.props.style as Record<string, number | undefined>;
  }

  it.each([
    { left: 0, right: 0, pl: undefined, pr: undefined },
    { left: 47, right: 59, pl: 47, pr: 59 },
  ] as const)('pads the loading wrapper (left=$left right=$right)', ({ left, right, pl, pr }) => {
    insetsState.left = left;
    insetsState.right = right;

    const style = loadingWrapperStyle();

    // Spread only when nonzero: the `px-4` className gutter must survive
    // portrait untouched (inline style wins over className), and the
    // horizontal swap must not change the paddingBottom that clears the bar.
    expect(style.paddingLeft).toBe(pl);
    expect(style.paddingRight).toBe(pr);
    expect(style.paddingBottom).toBe(32);
  });
});

describe('PrReviewDiscussionTab full-body states', () => {
  // Wording, not layout: the same states below must never call a GitLab
  // merge request a "pull request". Every other state's copy is already
  // provider-neutral, so it stays on one key.
  const GITLAB_REF: ProviderPrRef = {
    platform: 'gitlab',
    projectPath: 'group/sub/repo',
    mrIid: 12,
  };

  it.each(['permission', 'not-found', 'retryable'])('lets QueryError own the %s body', kind => {
    discussionState.firstPageErrorState = { kind };
    const renderer = mountTab();
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect(error.props.placement).toBeUndefined();
    expect(bottomPaddedViews(renderer)).toHaveLength(0);
    expectCtaPresence(renderer, false);
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
    expectCtaPresence(renderer, false);
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

  it.each(['load-more', 'loading', 'retry'] as const)(
    'keeps the %s footer reachable when normalization leaves no discussion rows',
    state => {
      discussionState.query.hasNextPage = state !== 'retry';
      discussionState.query.isFetchingNextPage = state === 'loading';
      discussionState.laterPageError = state === 'retry';
      const renderer = mountTab();
      const list = renderer.root.find(node => String(node.type) === 'PrReviewDiscussionList');
      expect(list.props.listItems).toEqual([]);
      expect(list.props.hasNextPage).toBe(state !== 'retry');
      expect(list.props.isFetchingNextPage).toBe(state === 'loading');
      expect(list.props.laterPageError).toBe(state === 'retry');
      expectCtaPresence(renderer, true);
      if (state !== 'loading') {
        act(() => {
          (list.props[state === 'retry' ? 'onRetryLoadMore' : 'onLoadMore'] as () => void)();
        });
        expect(
          state === 'retry' ? discussionState.query.refetch : discussionState.query.fetchNextPage
        ).toHaveBeenCalledOnce();
      }
      renderer.unmount();
    }
  );

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

  it.each([
    ['permission', GITLAB_REF, true],
    ['not-found', GITLAB_REF, true],
    ['permission', undefined, false],
    ['not-found', undefined, false],
  ] as const)('names a merge request in the %s copy', (kind, scope, forMergeRequest) => {
    discussionState.firstPageErrorState = { kind };
    const message = String(
      mountTab(scope).root.find(node => String(node.type) === 'QueryError').props.message
    );
    expect(message.includes('merge request')).toBe(forMergeRequest);
    expect(message).not.toContain(forMergeRequest ? 'pull request' : 'merge request');
  });

  it('names a merge request in the empty state description', () => {
    const description = (scopeRef?: ProviderPrRef) =>
      mountTab(scopeRef).root.find(node => String(node.type) === 'EmptyState').props
        .description as string;
    expect(description(GITLAB_REF)).toContain('merge request');
    expect(description()).toContain('pull request');
  });

  it('renders the happy list under the comment CTA bar', () => {
    discussionState.conversation = [{ nodeId: 'c1', createdAt: null }];
    const renderer = mountTab();

    expect(bottomPaddedViews(renderer)).toHaveLength(0);
    expect(
      renderer.root.findAll(node => String(node.type) === 'PrReviewDiscussionList')
    ).toHaveLength(1);
    expectCtaPresence(renderer, true);
  });

  it('hands the list the empty state a fully hidden discussion falls back to', () => {
    discussionState.conversation = [{ nodeId: 'c1', createdAt: null }];
    const list = mountTab().root.find(node => String(node.type) === 'PrReviewDiscussionList');

    // The list's blocked / muted filter can remove every row the page
    // returned; the tab hands it the empty state so the body never renders
    // blank, and the copy stays on one surface.
    expect(list.props.emptyState).toBeDefined();
  });

  it('renders the comment CTA bar on the empty view and opens the composer', () => {
    const renderer = mountTab();
    expect(renderer.root.find(node => String(node.type) === 'EmptyState')).toBeDefined();
    expectCtaPresence(renderer, true);
    act(() => {
      const cta = renderer.root.find(node => String(node.type) === 'PrCommentCta');
      (cta.props.onPress as () => void)();
    });
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/[owner]/[repo]/[number]/conversation-comment',
      params: { owner: 'octocat', repo: 'hello-world', number: 7 },
    });
  });

  it('opens the provider conversation-comment sheet under a GitLab scope', () => {
    // The provider route tree registers `conversation-comment`, not the
    // GitHub literal: pushing the GitHub route would leave the provider scope
    // and mount the GitHub layout with a GitHub-shaped triple (a GitLab
    // project path has no owner/repo split).
    const renderer = mountTab(GITLAB_REF);
    expectCtaPresence(renderer, true);
    act(() => {
      const cta = renderer.root.find(node => String(node.type) === 'PrCommentCta');
      (cta.props.onPress as () => void)();
    });
    expect(pushMock).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/sub/repo/12/conversation-comment'
    );
  });
});

// The bottom CTA bar opens the conversation-comment sheet. GitHub keeps the
// object-form push PR 6023 shipped; a GitLab MR / Bitbucket PR opens the
// sheet inside its own provider layout so the provider scope is published
// and the post reaches the right provider (PR 6023 parity).
describe('PrReviewDiscussionTab comment CTA routing by provider', () => {
  const GITLAB_REF: ProviderPrRef = {
    platform: 'gitlab',
    projectPath: 'group/sub/repo',
    mrIid: 12,
  };
  const BITBUCKET_REF: ProviderPrRef = {
    platform: 'bitbucket',
    workspace: 'acme',
    repoSlug: 'widgets',
    prId: 77,
  };

  function pressCta(scopeRef?: ProviderPrRef): void {
    const renderer = mountTab(scopeRef);
    act(() => {
      const cta = renderer.root.find(node => String(node.type) === 'PrCommentCta');
      (cta.props.onPress as () => void)();
    });
  }

  it('keeps GitHub on the legacy conversation-comment route', () => {
    pressCta();
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/[owner]/[repo]/[number]/conversation-comment',
      params: { owner: 'octocat', repo: 'hello-world', number: 7 },
    });
  });

  it('opens the GitLab conversation-comment sheet inside the provider layout', () => {
    pressCta(GITLAB_REF);
    expect(pushMock).toHaveBeenCalledWith(
      '/(app)/pr-review/gitlab/group/sub/repo/12/conversation-comment'
    );
  });

  it('opens the Bitbucket conversation-comment sheet inside the provider layout', () => {
    pressCta(BITBUCKET_REF);
    expect(pushMock).toHaveBeenCalledWith(
      '/(app)/pr-review/bitbucket/acme/widgets/77/conversation-comment'
    );
  });
});

// The keyboard-lift gating and the viewport-anchored reply scroll wiring
// (uxs3 spot check: e4-confirm-discard — a foreign sheet's keyboard lifted
// the bar behind it and clipped the last thread's reply field; e7-typed —
// the scroll parked against a pre-lift viewport). The scroll itself is
// covered by use-reply-focus-scroll.test.ts; here the TAB must hand the hook
// the real viewport commits and must gate the lift on screen focus.
describe('PrReviewDiscussionTab keyboard-lift gating and reply-scroll wiring', () => {
  beforeEach(() => {
    focusState.value = true;
  });

  function mountHappyList(): ReactTestRenderer {
    discussionState.conversation = [{ nodeId: 'c1', createdAt: null }];
    return mountTab();
  }

  function ctaKeyboardLift(): boolean | undefined {
    return (
      mountHappyList().root.find(node => String(node.type) === 'PrCommentCta').props as {
        keyboardLift?: boolean;
      }
    ).keyboardLift;
  }

  it('gates the CTA lift on screen focus: lifted while focused, parked while not', () => {
    expect(ctaKeyboardLift()).toBe(true);

    focusState.value = false;
    expect(ctaKeyboardLift()).toBe(false);
  });

  it('feeds the list viewport commits and reply focuses into the scroll hook, and a drag invalidates it', () => {
    const renderer = mountHappyList();
    const list = renderer.root.find(node => String(node.type) === 'PrReviewDiscussionList');
    const listProps = list.props as {
      onReplyInputFocus?: (index: number) => void;
      onViewportLayout?: (height: number) => void;
      onScrollBeginDrag?: () => void;
    };
    expect(listProps.onViewportLayout).toBeTypeOf('function');
    expect(listProps.onReplyInputFocus).toBeTypeOf('function');

    listProps.onReplyInputFocus?.(3);
    expect(replyScrollFns.markFocus).toHaveBeenCalledWith(3);
    listProps.onViewportLayout?.(420);
    expect(replyScrollFns.onViewportLayout).toHaveBeenCalledWith(420);

    // A user drag wins over the parked scroll (and still invalidates the
    // content-position settle, the pre-existing behavior).
    listProps.onScrollBeginDrag?.();
    expect(replyScrollFns.invalidate).toHaveBeenCalledTimes(1);
  });
});
