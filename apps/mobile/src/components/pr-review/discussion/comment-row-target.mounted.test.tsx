import { createElement } from 'react';
import { Pressable } from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { MoreHorizontal } from '@/components/ui/icons';
import { i18n } from '@/i18n';
import { type ReviewComment } from '@/lib/pr-review/discussion/review-discussion-types';
import { nativeDimensions } from '@/test/native-dimensions.test-helpers';
import { act, TestRenderer } from '@/test/renderer';
import { CommentRow } from './comment-row';

const { showActionSheet } = vi.hoisted(() => ({ showActionSheet: vi.fn() }));
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions: showActionSheet }),
}));
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutate: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@/lib/trpc', () => {
  const mutation = { mutationOptions: () => ({}) };
  return {
    useTRPC: () => ({
      moderation: {
        reportContent: mutation,
        reportUser: mutation,
        blockUser: mutation,
        muteUser: mutation,
      },
    }),
  };
});
vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/components/ui/icons', () => ({ MoreHorizontal: 'MoreHorizontal' }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./pr-comment-fix-with-kilo', () => ({ PrCommentFixWithKilo: 'PrCommentFixWithKilo' }));
vi.mock('./reactions-row', () => ({ ReactionsRow: 'ReactionsRow' }));
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6f6a61' }),
}));
vi.mock('@/lib/utils', () => ({
  parseTimestamp: () => new Date('2024-01-01T00:00:00Z'),
  timeAgo: () => '2d ago',
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([null, { login: 'alice', avatarUrl: 'https://example.com/a.png' }])(
  'reserves a 44-point comment actions target for author %j',
  async (author: ReviewComment['author']) => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(CommentRow, {
          comment: {
            commentId: 1,
            nodeId: 'C1',
            author,
            bodyMarkdown: 'hello',
            createdAt: '2024-01-01T00:00:00Z',
            reactions: [],
          },
          owner: 'octocat',
          repo: 'hello',
          number: 7,
          commentKind: 'review',
          onToggleReaction: vi.fn<() => void>(),
        })
      );
    });
    if (!renderer) {
      throw new Error('Missing comment renderer');
    }
    const button = renderer.root.findByType(Pressable);
    expect(await nativeDimensions(button.props.className as string)).toEqual([
      { height: 44, width: 44 },
    ]);
    expect((button.props.className as string).split(' ')).toContain('shrink-0');
    expect(button.props.hitSlop).toBeUndefined();
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe(i18n.t('prReview.discussion.commentActions'));
    expect(button.findByType(MoreHorizontal).props.size).toBe(16);
    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(showActionSheet).toHaveBeenCalledTimes(1);
  }
);
