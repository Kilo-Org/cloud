// Tap geometry of the review thread's resolve toggle: the size audit measures
// the frame a control renders, so this guards the frame that replaced the
// 24.5dp rem-scaled `h-7` box AND the compact 28pt visual inside it.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { DiscussionThread } from './discussion-thread';
import { COMPACT_H11_FRAME_DP, COMPACT_H11_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { type ReviewThread } from '@/lib/pr-review/discussion/review-discussion-types';

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
  useThemeColors: () => ({ foreground: '#000000', mutedForeground: '#6F6A61', good: '#22C55E' }),
}));
vi.mock('@/lib/pr-review/discussion/use-review-discussion-mutations', () => ({
  useAddReactionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveReactionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useReplyToCommentMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveThreadMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useUnresolveThreadMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const thread: ReviewThread = {
  threadId: 'T1',
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
      commentId: 1,
      nodeId: 'C1',
      author: { login: 'alice', avatarUrl: 'https://example.com/a.png' },
      bodyMarkdown: 'hello',
      createdAt: '2024-01-01T00:00:00Z',
      reactions: [],
    },
  ],
};

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(
      createElement(DiscussionThread, {
        owner: 'octocat',
        repo: 'hello',
        number: 1,
        thread,
        expanded: false,
        onToggleExpand: vi.fn<() => void>(),
      })
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- act() may not assign
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

describe('DiscussionThread resolve toggle touch target', () => {
  it('measures the frame, not the 14pt glyph, and reaches 44pt with its slop', async () => {
    const renderer = await render();

    const resolveButton = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Resolve thread'
    );

    // h-7 measured 24.5dp on device (NativeWind's 14pt rem) and was reported as
    // too small to tap; the frame is what a size audit measures.
    expect(resolveButton.props.className).toContain('h-11 w-11');
    expect(resolveButton.props.className).toContain('items-center');
    expect(resolveButton.props.className).toContain('justify-center');
    expect(resolveButton.props.hitSlop).toBe(COMPACT_H11_HIT_SLOP_DP);
    expect(COMPACT_H11_FRAME_DP + 2 * COMPACT_H11_HIT_SLOP_DP).toBeGreaterThanOrEqual(44);

    // The visible circle keeps its compact 28pt size inside the frame.
    const circle = resolveButton.find(
      node =>
        typeof node.type === 'string' && String(node.props.className).includes('h-[28px] w-[28px]')
    );
    expect(circle).toBeDefined();

    renderer.unmount();
  });
});
