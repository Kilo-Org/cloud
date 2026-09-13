import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionMessageList } from './session-message-list';

const flashListProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const controls = vi.hoisted(() => ({
  isAtBottom: true,
  leftInset: 0,
  rightInset: 0,
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashListProps.current = props;
    return null;
  },
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  Keyboard: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({
    top: 0,
    bottom: 0,
    left: controls.leftInset,
    right: controls.rightInset,
  }),
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
    isAtBottom: controls.isAtBottom,
    listRef: { current: null },
    scrollToLatestAnimated: vi.fn(),
    handleContentSizeChange: vi.fn(),
    handleKeyboardShow: vi.fn(),
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

// `Object.is` keeps the host-string comparison off the ElementType union.
function scrollButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(node => Object.is(node.type, 'AnimatedView'));
}

describe('SessionMessageList landscape side insets', () => {
  const baseProps = {
    sessionId: 'session-1',
    items: ['message-1'],
    keyExtractor: (item: string) => item,
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    olderMessagesError: null,
    olderMessagesOmittedItemCount: 0,
    onLoadOlderMessages: () => undefined,
    renderItem: () => null,
  };

  function mountList(
    overrides: Partial<Parameters<typeof SessionMessageList<string>>[0]> = {}
  ): TestRenderer.ReactTestRenderer {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(SessionMessageList<string>, { ...baseProps, ...overrides })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    return renderer;
  }

  afterEach(() => {
    controls.isAtBottom = true;
    controls.leftInset = 0;
    controls.rightInset = 0;
  });

  it('keeps the module style reference and a 16pt control offset in portrait', () => {
    controls.isAtBottom = false;
    const renderer = mountList();
    const style = flashListProps.current?.contentContainerStyle;
    expect(style).toEqual({ paddingVertical: 8 });
    expect(scrollButton(renderer).props.style).toEqual({ right: 16 });

    // Unchanged inputs keep the same style reference so FlashList's portrait
    // behavior (including `maintainVisibleContentPosition`) is untouched.
    act(() => {
      renderer.update(createElement(SessionMessageList<string>, { ...baseProps }));
    });
    expect(flashListProps.current?.contentContainerStyle).toBe(style);

    // A fresh mount shares the reference too: it is the module-level constant,
    // not a per-mount allocation.
    const remounted = mountList();
    expect(flashListProps.current?.contentContainerStyle).toBe(style);
    expect(scrollButton(remounted).props.style).toEqual({ right: 16 });
  });

  it('pads the transcript and offsets the control by the landscape side insets', () => {
    controls.isAtBottom = false;
    controls.leftInset = 47;
    controls.rightInset = 59;
    const renderer = mountList();
    expect(flashListProps.current?.contentContainerStyle).toEqual({
      paddingTop: 8,
      paddingBottom: 8,
      paddingLeft: 47,
      paddingRight: 59,
    });
    expect(scrollButton(renderer).props.style).toEqual({ right: 75 });
  });

  it('carries the side paddings when a content bottom inset is provided', () => {
    mountList({ contentBottomInset: 34 });
    expect(flashListProps.current?.contentContainerStyle).toEqual({
      paddingTop: 8,
      paddingBottom: 42,
      paddingLeft: 0,
      paddingRight: 0,
    });
  });
});
