import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewDiscussionTab } from './pr-review-discussion-tab';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

const pushMock = vi.hoisted(() => vi.fn());

// The tab's screen focus drives the CTA bar's keyboard lift (a foreign
// surface's keyboard must not lift the bar behind it — uxs3, e4-confirm-
// discard). Flippable so the suite can mount the tab unfocused.
const focusState = vi.hoisted(() => ({ value: true }));

const replyScrollFns = vi.hoisted(() => ({
  markFocus: vi.fn(),
  onViewportLayout: vi.fn(),
  invalidate: vi.fn(),
}));

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
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock }),
  useIsFocused: () => focusState.value,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
vi.mock('@/lib/pr-review/discussion/use-pr-review-discussion-threads', () => ({
  usePrReviewDiscussionThreads: () => discussionState,
}));
vi.mock('@/lib/pr-review/discussion/use-reply-focus-scroll', () => ({
  // The tab-level focus scroll is covered by use-reply-focus-scroll.test.ts;
  // here it is inert so the tab body states stay the subject.
  useReplyFocusScroll: () => replyScrollFns,
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
vi.mock('@/components/pr-review/discussion/pr-comment-cta', () => ({
  PrCommentCta: 'PrCommentCta',
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

function expectCtaPresence(renderer: TestRenderer.ReactTestRenderer, present: boolean): void {
  const ctas = renderer.root.findAll(node => String(node.type) === 'PrCommentCta');
  expect(ctas.length > 0).toBe(present);
}

describe('PrReviewDiscussionTab loading skeleton side insets (landscape)', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
    resetState();
  });

  function loadingWrapperStyle(): Record<string, number | undefined> {
    discussionState.query.isPending = true;
    const views = bottomPaddedViews(mountTab());
    expect(views).toHaveLength(1);
    const view = views[0];
    if (!view) {
      throw new Error('expected a padded View');
    }
    return view.props.style as Record<string, number | undefined>;
  }

  it('keeps exactly the current style keys at zero portrait insets', () => {
    const style = loadingWrapperStyle();

    // Spread only when nonzero: the `px-4` className gutter must survive
    // portrait untouched (inline style wins over className).
    expect(style.paddingLeft).toBeUndefined();
    expect(style.paddingRight).toBeUndefined();
    expect(style.paddingBottom).toBe(32);
  });

  it('clears the sensor housing with the landscape side insets', () => {
    insetsState.left = 47;
    insetsState.right = 59;

    const style = loadingWrapperStyle();

    expect(style.paddingLeft).toBe(47);
    expect(style.paddingRight).toBe(59);
    // The skeleton gutter swap is horizontal-only: the paddingBottom that
    // clears the system bar is unchanged.
    expect(style.paddingBottom).toBe(32);
  });
});

describe('PrReviewDiscussionTab full-body states', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    pushMock.mockClear();
    resetState();
  });

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

  it('keeps the loading skeleton padding', () => {
    discussionState.query.isPending = true;
    expectSinglePadding(mountTab(), 32);
    expectCtaPresence(mountTab(), false);
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

  it('renders the happy list under the comment CTA bar', () => {
    discussionState.conversation = [{ nodeId: 'c1', createdAt: null }];
    const renderer = mountTab();

    expect(bottomPaddedViews(renderer)).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'PrReviewDiscussionList'
      )
    ).toHaveLength(1);
    expectCtaPresence(renderer, true);
  });

  it('renders the comment CTA bar on the empty view', () => {
    const renderer = mountTab();
    expect(renderer.root.find(node => String(node.type) === 'EmptyState')).toBeDefined();
    expectCtaPresence(renderer, true);
  });

  it('pushes the conversation-comment route from the CTA bar', () => {
    const renderer = mountTab();
    const cta = renderer.root.find(node => String(node.type) === 'PrCommentCta');
    act(() => {
      (cta.props.onPress as () => void)();
    });
    expect(pushMock).toHaveBeenCalledWith({
      pathname: '/(app)/pr-review/[owner]/[repo]/[number]/conversation-comment',
      params: { owner: 'octocat', repo: 'hello-world', number: 7 },
    });
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
    resetState();
    replyScrollFns.markFocus.mockClear();
    replyScrollFns.onViewportLayout.mockClear();
    replyScrollFns.invalidate.mockClear();
  });

  function mountHappyList(): TestRenderer.ReactTestRenderer {
    discussionState.conversation = [{ nodeId: 'c1', createdAt: null }];
    return mountTab();
  }

  it('gates the CTA lift on screen focus: lifted while focused, parked while not', () => {
    const focused = mountHappyList();
    expect(
      (
        focused.root.find(node => String(node.type) === 'PrCommentCta').props as {
          keyboardLift?: boolean;
        }
      ).keyboardLift
    ).toBe(true);

    focusState.value = false;
    const blurred = mountHappyList();
    expect(
      (
        blurred.root.find(node => String(node.type) === 'PrCommentCta').props as {
          keyboardLift?: boolean;
        }
      ).keyboardLift
    ).toBe(false);
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
