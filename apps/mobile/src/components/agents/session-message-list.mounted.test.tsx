/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the React Native tree without a device */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { SessionMessageList } from './session-message-list';

const flashListProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashListProps.current = props;
    return null;
  },
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: 'black' }),
}));
vi.mock('@/components/agents/use-session-list-auto-scroll', () => ({
  useSessionListAutoScroll: () => ({
    isAtBottom: true,
    listRef: { current: null },
    scrollToLatestAnimated: vi.fn(),
    handleContentSizeChange: vi.fn(),
    handleListLayout: vi.fn(),
    handleScroll: vi.fn(),
    handleScrollBeginDrag: vi.fn(),
    handleScrollEndDrag: vi.fn(),
    handleMomentumScrollBegin: vi.fn(),
    handleMomentumScrollEnd: vi.fn(),
  }),
}));
vi.mock('@/components/agents/session-pagination-header', () => ({
  SessionPaginationHeader: () => null,
}));

describe('SessionMessageList', () => {
  it('disables clipped subviews to avoid Android Fabric reattachment races', () => {
    act(() => {
      TestRenderer.create(
        createElement(SessionMessageList<string>, {
          sessionId: 'session-1',
          items: ['message-1'],
          keyExtractor: item => item,
          hasOlderMessages: false,
          isLoadingOlderMessages: false,
          olderMessagesError: null,
          olderMessagesOmittedItemCount: 0,
          onLoadOlderMessages: () => undefined,
          renderItem: () => null,
        })
      );
    });

    expect(flashListProps.current?.removeClippedSubviews).toBe(false);
  });
});
