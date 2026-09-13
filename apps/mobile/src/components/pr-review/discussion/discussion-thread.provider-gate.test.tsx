/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to test React/RN structure under vitest */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { type ReviewThread } from '@/lib/pr-review/discussion/review-discussion-types';
import { type ProviderPrRef, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';

import { DiscussionThread } from './discussion-thread';

// The s6 write arm of the provider discussion surface. The reply and resolve
// mutations route through the `providerReview` seam on a GitLab MR / Bitbucket
// PR (the hooks pick the arm from the provider scope the layout publishes), so
// the thread OFFERS resolve and reply on every platform whose capabilities
// allow it — with the provider-native ids (discussion id / verbatim comment
// id) riding on the wire. Reactions have no seam write path and no provider
// read layer returns reaction data, so a provider comment row stays read-only:
// the row shows nothing rather than a dead or failing affordance, and the
// capability flag removes the reaction row entirely where the provider says
// unsupported (Bitbucket). The read-only facts the providers DO report — the
// Resolved badge — stay rendered.

const GITLAB_REF: ProviderPrRef = { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 };
const BITBUCKET_REF: ProviderPrRef = {
  platform: 'bitbucket',
  workspace: 'acme',
  repoSlug: 'api',
  prId: 42,
};

function makeThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    threadId: 'D-12',
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
        commentId: 12,
        nodeId: '12',
        author: { login: 'alice', avatarUrl: null },
        bodyMarkdown: 'hello',
        createdAt: '2024-01-01T00:00:00Z',
        reactions: [],
      },
    ],
    ...overrides,
  };
}

const baseProps = {
  owner: 'group/sub',
  repo: 'repo',
  number: 12,
  onToggleExpand: vi.fn<() => void>(),
};

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/ui/icons', () => ({
  Check: 'Check',
  CheckCheck: 'CheckCheck',
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
}));
vi.mock('@/components/pr-review/discussion/comment-row', () => ({ CommentRow: 'CommentRow' }));
vi.mock('@/components/pr-review/discussion/reply-input', () => ({ ReplyInput: 'ReplyInput' }));
vi.mock('@/components/pr-review/discussion/thread-diff-snippet', () => ({
  ThreadDiffSnippet: 'ThreadDiffSnippet',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', good: '#22C55E' }),
}));
const { resolveMutate } = vi.hoisted(() => ({ resolveMutate: vi.fn<() => void>() }));

vi.mock('@/lib/pr-review/discussion/use-review-discussion-mutations', () => ({
  useAddReactionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveReactionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useReplyToCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveThreadMutation: () => ({ mutate: resolveMutate, isPending: false }),
  useUnresolveThreadMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

function countByType(
  root: TestRenderer.ReactTestInstance,
  type: string,
  match?: (props: Record<string, unknown>) => boolean
): number {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === type &&
      (match === undefined || match(node.props as Record<string, unknown>))
  ).length;
}

async function renderThread(
  ref: ProviderPrRef | null,
  expanded: boolean,
  thread: ReviewThread
): Promise<TestRenderer.ReactTestRenderer> {
  const card = createElement(DiscussionThread, { ...baseProps, thread, expanded });
  const tree = ref ? (
    <ProviderPrScopeProvider value={{ ref, organizationId: null }}>{card}</ProviderPrScopeProvider>
  ) : (
    card
  );
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(tree);
  });
  // Runtime safety: act() could theoretically fail without assigning.
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

function pressableCount(root: TestRenderer.ReactTestInstance, label: string): number {
  return countByType(
    root,
    'Pressable',
    props => props.accessibilityLabel === label || props.children === label
  );
}

/** Press the resolve toggle (its own nested pressable in the header). */
function pressResolve(root: TestRenderer.ReactTestInstance): void {
  const resolveToggle = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'Pressable' &&
      (node.props as Record<string, unknown>).accessibilityLabel === 'Resolve thread'
  )[0];
  if (!resolveToggle) {
    throw new Error('Resolve toggle not found');
  }
  (resolveToggle.props as { onPress?: () => void }).onPress?.();
}

describe('DiscussionThread provider write arm (s6)', () => {
  it.each<[string, ProviderPrRef]>([
    ['gitlab', GITLAB_REF],
    ['bitbucket', BITBUCKET_REF],
  ])('offers resolve and reply through the seam on a %s thread', async (_platform, ref) => {
    const renderer = await renderThread(ref, true, makeThread());
    try {
      // Resolve is offered and carries the provider-native thread id.
      expect(pressableCount(renderer.root, 'Resolve thread')).toBe(1);
      pressResolve(renderer.root);
      expect(resolveMutate).toHaveBeenCalledWith({ threadId: 'D-12' });

      // Reply is offered with the provider target (discussion id + verbatim
      // comment id), so the seam posts it for this provider identity.
      expect(countByType(renderer.root, 'ReplyInput')).toBe(1);
      const replyInput = renderer.root.find(
        node => typeof node.type === 'string' && (node.type as string) === 'ReplyInput'
      );
      expect(replyInput.props.provider).toEqual({
        ref,
        threadId: 'D-12',
        commentNodeId: '12',
      });

      expect(countByType(renderer.root, 'CommentRow')).toBe(1);
    } finally {
      renderer.unmount();
    }
  });

  it('makes thread comments read-only on a provider scope (no reaction write path)', async () => {
    const renderer = await renderThread(GITLAB_REF, true, makeThread());
    try {
      const row = renderer.root.find(
        node => typeof node.type === 'string' && (node.type as string) === 'CommentRow'
      );
      expect(row.props.readOnly).toBe(true);
      // GitLab's capability says reactions are supported, so the row is
      // gated on the flag (true) — but it is read-only and the read layer
      // returns no reaction data, so nothing renders.
      expect(row.props.reactionsSupported).toBe(true);
    } finally {
      renderer.unmount();
    }
  });

  it('drops the reaction row entirely on a Bitbucket thread (capability unsupported)', async () => {
    const renderer = await renderThread(BITBUCKET_REF, true, makeThread());
    try {
      const row = renderer.root.find(
        node => typeof node.type === 'string' && (node.type as string) === 'CommentRow'
      );
      expect(row.props.reactionsSupported).toBe(false);
      expect(row.props.readOnly).toBe(true);
    } finally {
      renderer.unmount();
    }
  });

  it('keeps the resolve toggle, reply input and writable reactions on GitHub', async () => {
    const renderer = await renderThread(null, true, makeThread());
    try {
      expect(pressableCount(renderer.root, 'Resolve thread')).toBe(1);
      expect(countByType(renderer.root, 'ReplyInput')).toBe(1);
      const replyInput = renderer.root.find(
        node => typeof node.type === 'string' && (node.type as string) === 'ReplyInput'
      );
      // GitHub carries no provider target — the exact pre-s6 call shape.
      expect(replyInput.props.provider).toBeUndefined();
      const row = renderer.root.find(
        node => typeof node.type === 'string' && (node.type as string) === 'CommentRow'
      );
      expect(row.props.readOnly).toBe(false);
    } finally {
      renderer.unmount();
    }
  });

  it('keeps the read-only Resolved badge on a provider thread', async () => {
    const renderer = await renderThread(GITLAB_REF, false, makeThread({ isResolved: true }));
    try {
      // Collapsed provider thread: the unresolve affordance is offered
      // through the seam, and the read-only Resolved badge stays.
      expect(pressableCount(renderer.root, 'Unresolve thread')).toBe(1);
      expect(countByType(renderer.root, 'Text', props => props.children === 'Resolved')).toBe(1);
    } finally {
      renderer.unmount();
    }
  });
});
