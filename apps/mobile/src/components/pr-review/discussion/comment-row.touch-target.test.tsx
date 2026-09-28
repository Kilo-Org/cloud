// Tap geometry of the comment row's overflow (moderation) control: the size
// audit measures the frame a control renders, so this guards the frame that
// replaced the 24.5dp rem-scaled `h-7` box AND the compact 28pt visual inside
// it. See `comment-trailing-controls.ts` for the shared arithmetic.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { CommentRow } from './comment-row';
import { CommentModerationProvider } from './comment-moderation';
import { MIN_TAP_TARGET_DP } from '@/lib/a11y/tap-target';
import {
  COMMENT_ACTIONS_FRAME_DP,
  COMMENT_ACTIONS_HIT_SLOP,
  COMMENT_ACTIONS_VISUAL_DP,
} from '@/lib/pr-review/comment-trailing-controls';
import { type ReviewComment } from '@/lib/pr-review/discussion/review-discussion-types';

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  View: 'View',
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: vi.fn() }),
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/components/ui/icons', () => ({ MoreHorizontal: 'MoreHorizontal' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/pr-review/discussion/pr-comment-fix-with-kilo', () => ({
  PrCommentFixWithKilo: 'PrCommentFixWithKilo',
}));
vi.mock('@/components/pr-review/discussion/reactions-row', () => ({
  ReactionsRow: 'ReactionsRow',
}));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61' }),
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: {
      listHiddenUsers: { queryKey: () => ['moderation', 'listHiddenUsers'] },
      reportContent: { mutationOptions: (opts: unknown) => opts },
      reportUser: { mutationOptions: (opts: unknown) => opts },
      blockUser: { mutationOptions: (opts: unknown) => opts },
      muteUser: { mutationOptions: (opts: unknown) => opts },
    },
  }),
}));
vi.mock('@/lib/utils', () => ({
  parseTimestamp: () => new Date('2024-01-01T00:00:00Z'),
  timeAgo: () => '2d ago',
}));

const comment: ReviewComment = {
  commentId: 1,
  nodeId: 'C1',
  author: { login: 'alice', avatarUrl: 'https://example.com/a.png' },
  bodyMarkdown: 'hello',
  createdAt: '2024-01-01T00:00:00Z',
  reactions: [],
};

async function render(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    await Promise.resolve();
    renderer = TestRenderer.create(
      createElement(
        CommentModerationProvider,
        null,
        createElement(CommentRow, {
          comment,
          owner: 'octocat',
          repo: 'hello',
          number: 7,
          commentKind: 'review',
          onToggleReaction: vi.fn<() => void>(),
          viewerLogin: 'bob',
        })
      )
    );
  });
  // eslint-disable-next-line typescript-eslint/no-unnecessary-condition -- act() may not assign
  if (!renderer) {
    throw new Error('Failed to create test renderer');
  }
  return renderer;
}

describe('CommentRow overflow touch target', () => {
  it('measures the frame, not the 16pt glyph, and reaches 44pt with its slop', async () => {
    const renderer = await render();

    const overflow = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Pressable' &&
        node.props.accessibilityLabel === 'Comment actions'
    );

    // h-7 measured 24.5dp on device (NativeWind's 14pt rem) and was reported as
    // too small to tap; the frame is what a size audit measures.
    expect(overflow.props.className).toContain('h-11 w-11');
    expect(overflow.props.className).toContain('items-center');
    expect(overflow.props.className).toContain('justify-center');
    expect(overflow.props.hitSlop).toEqual(COMMENT_ACTIONS_HIT_SLOP);
    expect(COMMENT_ACTIONS_FRAME_DP).toBeGreaterThanOrEqual(MIN_TAP_TARGET_DP);
    expect(
      COMMENT_ACTIONS_FRAME_DP + COMMENT_ACTIONS_HIT_SLOP.top + COMMENT_ACTIONS_HIT_SLOP.bottom
    ).toBeGreaterThanOrEqual(44);

    // The visible circle keeps its compact size inside the frame.
    const circleClass = `h-[${COMMENT_ACTIONS_VISUAL_DP}px] w-[${COMMENT_ACTIONS_VISUAL_DP}px]`;
    const circle = overflow.find(
      node => typeof node.type === 'string' && String(node.props.className).includes(circleClass)
    );
    expect(circle).toBeDefined();

    renderer.unmount();
  });
});
