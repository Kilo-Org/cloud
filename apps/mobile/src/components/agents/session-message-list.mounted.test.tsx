import { createElement, type Ref, useImperativeHandle } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionMessageList } from './session-message-list';

const flashListProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const scrollMock = vi.hoisted(() => ({ scrollToEnd: vi.fn() }));
const insets = vi.hoisted(() => ({ left: 0, right: 0 }));

// The real `useSessionListAutoScroll` hook is exercised here (not a stub), so
// the ref it hands FlashList must expose `scrollToEnd` for the auto-scroll
// assertions to observe. `useImperativeHandle` wires that ref.
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashListProps.current = props;
    useImperativeHandle(props.ref as Ref<typeof scrollMock>, () => scrollMock, []);
    return null;
  },
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: false, scrollAnimated: true }),
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
    left: insets.left,
    right: insets.right,
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
vi.mock('@/components/agents/session-pagination-header', () => ({
  SessionPaginationHeader: () => null,
}));

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

const mounted: TestRenderer.ReactTestRenderer[] = [];

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
  mounted.push(renderer);
  return renderer;
}

function rerenderList(
  renderer: TestRenderer.ReactTestRenderer,
  overrides: Partial<Parameters<typeof SessionMessageList<string>>[0]> = {}
): void {
  act(() => {
    renderer.update(createElement(SessionMessageList<string>, { ...baseProps, ...overrides }));
  });
}

// `Object.is` keeps the host-string comparison off the ElementType union.
function scrollButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(node => Object.is(node.type, 'AnimatedView'));
}

type ScrollHandler = ((event?: unknown) => void) | undefined;

function fire(name: string, event?: unknown): void {
  const props = (flashListProps.current ?? {}) as Record<string, ScrollHandler>;
  const handler = props[name];
  act(() => {
    handler?.(event);
  });
}

const AT_BOTTOM_EVENT = {
  nativeEvent: {
    contentOffset: { y: 950 },
    contentSize: { height: 1500, width: 0 },
    layoutMeasurement: { height: 500, width: 0 },
  },
};

const AWAY_FROM_BOTTOM_EVENT = {
  nativeEvent: {
    contentOffset: { y: 0 },
    contentSize: { height: 5000, width: 0 },
    layoutMeasurement: { height: 500, width: 0 },
  },
};

// Ends the mount-time programmatic-scroll window and lands the hook in the
// "user is at the bottom" state, as a real transcript does a beat after open.
function settleAtBottom(): void {
  fire('onScrollBeginDrag');
  fire('onScrollEndDrag', AT_BOTTOM_EVENT);
  fire('onMomentumScrollEnd', AT_BOTTOM_EVENT);
}

// Mimics the user's upward drag: clears the auto-scroll latch and moves the
// viewport away from the bottom so the "scroll to bottom" control renders.
function scrollAwayFromBottom(): void {
  fire('onScrollBeginDrag');
  fire('onScroll', AWAY_FROM_BOTTOM_EVENT);
}

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
  scrollMock.scrollToEnd.mockClear();
  flashListProps.current = null;
  insets.left = 0;
  insets.right = 0;
});

describe('SessionMessageList', () => {
  it('disables clipped subviews to avoid Android Fabric reattachment races', () => {
    mountList();
    expect(flashListProps.current?.removeClippedSubviews).toBe(false);
  });

  it('mounts rows well ahead of the viewport during a fast fling', () => {
    mountList();
    expect(flashListProps.current?.drawDistance).toBe(2000);
  });
});

describe('SessionMessageList older-page auto-scroll', () => {
  it('does not yank the viewport when an older page is prepended', () => {
    const renderer = mountList({ items: ['m1', 'm2'], hasOlderMessages: true });
    settleAtBottom();
    scrollMock.scrollToEnd.mockClear();

    rerenderList(renderer, { items: ['m0', 'm1', 'm2'], hasOlderMessages: true });

    expect(scrollMock.scrollToEnd).not.toHaveBeenCalled();
  });

  it('still follows a new newest message appended at the bottom', () => {
    const renderer = mountList({ items: ['m1', 'm2'], hasOlderMessages: true });
    settleAtBottom();
    scrollMock.scrollToEnd.mockClear();

    rerenderList(renderer, { items: ['m1', 'm2', 'm3'], hasOlderMessages: true });

    expect(scrollMock.scrollToEnd).toHaveBeenCalled();
  });
});

describe('SessionMessageList landscape side insets', () => {
  it('keeps the module style reference and a 16pt control offset in portrait', () => {
    const renderer = mountList();
    scrollAwayFromBottom();
    const style = flashListProps.current?.contentContainerStyle;
    expect(style).toEqual({ paddingVertical: 8 });
    expect(scrollButton(renderer).props.style).toEqual({ right: 16 });

    // Unchanged inputs keep the same style reference so FlashList's portrait
    // behavior (including `maintainVisibleContentPosition`) is untouched.
    rerenderList(renderer);
    expect(flashListProps.current?.contentContainerStyle).toBe(style);

    // A fresh mount shares the reference too: it is the module-level constant,
    // not a per-mount allocation.
    const remounted = mountList();
    expect(flashListProps.current?.contentContainerStyle).toBe(style);
    scrollAwayFromBottom();
    expect(scrollButton(remounted).props.style).toEqual({ right: 16 });
  });

  it('pads the transcript and offsets the control by the landscape side insets', () => {
    insets.left = 47;
    insets.right = 59;
    const renderer = mountList();
    scrollAwayFromBottom();
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
