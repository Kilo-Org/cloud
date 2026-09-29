// Test support for pr-review-discussion-tab.test.tsx: the module-mock harness,
// the shared fixtures, and the render/query helpers. The vi.mock
// registrations in this module body run while it is evaluated — which is why
// the test file must import this module FIRST, before the tab or any other
// module that has to resolve against these mocks.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { expect, vi } from 'vitest';

import { type ProviderPrRef, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';

import { PrReviewDiscussionTab } from './pr-review-discussion-tab';

const hoisted = vi.hoisted(() => ({
  insetsState: { top: 0, bottom: 0, left: 0, right: 0 },
  pushMock: vi.fn(),
  // The tab's screen focus drives the CTA bar's keyboard lift (a foreign
  // surface's keyboard must not lift the bar behind it — uxs3, e4-confirm-
  // discard). Flippable so the suite can mount the tab unfocused.
  focusState: { value: true },
  replyScrollFns: {
    markFocus: vi.fn(),
    onViewportLayout: vi.fn(),
    invalidate: vi.fn(),
  },
  discussionState: {
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
  },
}));

export const insetsState = hoisted.insetsState;
export const pushMock = hoisted.pushMock;
export const focusState = hoisted.focusState;
export const replyScrollFns = hoisted.replyScrollFns;
export const discussionState = hoisted.discussionState;

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
// The tab mounts the shared moderation provider around the list; here it is a
// plain host node so the tab suite can assert the nesting (the provider's own
// behaviour is covered by comment-row.test.tsx, which mounts the real one).
vi.mock('@/components/pr-review/discussion/comment-moderation', () => ({
  CommentModerationProvider: 'CommentModerationProvider',
}));
vi.mock('@/components/pr-review/discussion/pr-comment-cta', () => ({
  PrCommentCta: 'PrCommentCta',
}));

export const BASE_PROPS = {
  owner: 'octocat',
  repo: 'hello-world',
  number: 7,
  onRequestFiles: vi.fn(() => undefined),
};

/** Mounts the tab, optionally under a provider scope (no scope = GitHub). */
export function mountTab(scopeRef?: ProviderPrRef): TestRenderer.ReactTestRenderer {
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

/** Re-renders the mounted tab in place with the same props, so a test can
 * compare a prop's identity across two renders of one component instance. */
export function rerenderTab(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.update(createElement(PrReviewDiscussionTab, BASE_PROPS));
  });
}

export function bottomPaddedViews(
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

export function resetState(): void {
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

export function expectCtaPresence(
  renderer: TestRenderer.ReactTestRenderer,
  present: boolean
): void {
  const ctas = renderer.root.findAll(node => String(node.type) === 'PrCommentCta');
  expect(ctas.length > 0).toBe(present);
}
