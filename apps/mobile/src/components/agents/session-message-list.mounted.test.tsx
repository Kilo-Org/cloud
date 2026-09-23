/* eslint-disable max-lines -- the older-page, landscape-inset, resume-anchor and anchor-reporting suites share this file's real FlashList and auto-scroll harness. */
import { createElement, type ReactElement, type Ref, useImperativeHandle } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionMessageList } from './session-message-list';
import { getSessionTranscriptItemKey, type SessionTranscriptItem } from './session-transcript';
import { MAX_RESUME_OLDER_LOADS } from '@/lib/session-resume';
import { stubTextPart, stubUserMessage } from '@kilocode/cloud-agent-sdk/test-helpers';

const flashListProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const scrollMock = vi.hoisted(() => ({ scrollToEnd: vi.fn(), scrollToIndex: vi.fn() }));
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
  scrollMock.scrollToIndex.mockClear();
  flashListProps.current = null;
  insets.left = 0;
  insets.right = 0;
  vi.useRealTimers();
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

describe('SessionMessageList pagination header', () => {
  it('keeps the header element when only the load-handler identity changes', () => {
    const renderer = mountList();
    const header = flashListProps.current?.ListHeaderComponent;
    expect(header).toBeTruthy();

    // The host passes a fresh inline arrow on every render; that alone must not
    // hand FlashList a new header element (which would remount/reflow it).
    rerenderList(renderer, { onLoadOlderMessages: () => undefined });

    expect(flashListProps.current?.ListHeaderComponent).toBe(header);
  });

  it('retries through the newest load handler after the host re-renders', () => {
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    const renderer = mountList({ onLoadOlderMessages: first });
    const header = flashListProps.current?.ListHeaderComponent as ReactElement<{
      onRetry: () => void;
    }>;

    rerenderList(renderer, { onLoadOlderMessages: second });
    act(() => {
      header.props.onRetry();
    });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
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

function resumeItem(id: string): SessionTranscriptItem {
  return {
    type: 'message',
    message: {
      info: stubUserMessage({ id, sessionID: 'session-1' }),
      parts: [stubTextPart({ id: `${id}:text`, sessionID: 'session-1', messageID: id })],
    },
  };
}

describe('SessionMessageList resume anchor', () => {
  const resumeBaseProps = {
    sessionId: 'session-1',
    keyExtractor: (item: SessionTranscriptItem) => getSessionTranscriptItemKey(item),
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    olderMessagesError: null,
    olderMessagesOmittedItemCount: 0,
    onLoadOlderMessages: () => undefined,
    renderItem: () => null,
  };

  type ResumeProps = Parameters<typeof SessionMessageList<SessionTranscriptItem>>[0];

  function resumeElement(overrides: Partial<ResumeProps>) {
    return createElement(SessionMessageList<SessionTranscriptItem>, {
      ...resumeBaseProps,
      ...overrides,
      // Restated so the required `items` prop keeps its non-optional type
      // through the partial spread.
      items: overrides.items ?? [],
    });
  }

  function mountResumeList(overrides: Partial<ResumeProps>): TestRenderer.ReactTestRenderer {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(resumeElement(overrides));
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    mounted.push(renderer);
    return renderer;
  }

  it('opens without tail auto-follow so the resume scroll is not overridden', () => {
    mountResumeList({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });

    // The mount-time scroll to the newest message (and its 80ms retry) would
    // otherwise discard the resume position before the user sees it.
    expect(scrollMock.scrollToEnd).not.toHaveBeenCalled();
  });

  it('keeps tail auto-follow for a session opened without an anchor', () => {
    mountResumeList({ items: [resumeItem('msg-1')] });
    expect(scrollMock.scrollToEnd).toHaveBeenCalled();
    scrollMock.scrollToEnd.mockClear();

    mountResumeList({ items: [resumeItem('msg-1')], resumeAt: '' });
    expect(scrollMock.scrollToEnd).toHaveBeenCalled();
  });

  it('scrolls to the anchor row index once the rows are present', () => {
    vi.useFakeTimers();
    mountResumeList({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });

    // The mount run defers to the bounded retries: a mount-time scroll loses
    // the cold-open race to FlashList's own bottom-start initial scroll and
    // the estimate settle (device-proven), so the retries perform the scroll
    // once the rows are measured.
    expect(scrollMock.scrollToIndex).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(scrollMock.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      viewPosition: 0,
      viewOffset: 1,
      animated: false,
    });
  });

  it('scrolls nothing and requests nothing for an unknown anchor with no older history', () => {
    const onLoad = vi.fn<() => void>();
    mountResumeList({
      items: [resumeItem('msg-1')],
      resumeAt: 'msg-gone',
      hasOlderMessages: false,
      onLoadOlderMessages: onLoad,
    });

    expect(scrollMock.scrollToIndex).not.toHaveBeenCalled();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('stops requesting older pages at the bound', () => {
    const onLoad = vi.fn<() => void>();
    const renderer = mountResumeList({
      items: [resumeItem('msg-1')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
    });
    expect(onLoad).toHaveBeenCalledTimes(1);

    for (let i = 0; i < MAX_RESUME_OLDER_LOADS + 4; i += 1) {
      act(() => {
        // A fresh items array per render, as a new prop identity is in the app.
        renderer.update(
          resumeElement({
            items: [resumeItem('msg-1')],
            resumeAt: 'msg-older',
            hasOlderMessages: true,
            onLoadOlderMessages: onLoad,
          })
        );
      });
    }

    expect(onLoad).toHaveBeenCalledTimes(MAX_RESUME_OLDER_LOADS);
    expect(scrollMock.scrollToIndex).not.toHaveBeenCalled();
  });

  it('spends the page budget on requests, not on re-runs while a page is in flight', () => {
    const onLoad = vi.fn<() => void>();
    const renderer = mountResumeList({
      items: [resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
    });
    expect(onLoad).toHaveBeenCalledTimes(1);

    // Streaming updates while the requested page is in flight: each re-render
    // changes `items` and re-runs the resume plan. None of them is a new page
    // request, so none may consume the page budget — a burst that does would
    // mark the resume done before the anchor's page can arrive.
    for (let i = 0; i < MAX_RESUME_OLDER_LOADS + 4; i += 1) {
      act(() => {
        renderer.update(
          resumeElement({
            items: [resumeItem(`msg-stream-${i}`), resumeItem('msg-new')],
            resumeAt: 'msg-older',
            hasOlderMessages: true,
            isLoadingOlderMessages: true,
            onLoadOlderMessages: onLoad,
          })
        );
      });
    }
    expect(onLoad).toHaveBeenCalledTimes(1);

    // The anchor's page lands: the resume still scrolls to it.
    act(() => {
      renderer.update(
        resumeElement({
          items: [resumeItem('msg-older'), resumeItem('msg-new')],
          resumeAt: 'msg-older',
          hasOlderMessages: true,
          onLoadOlderMessages: onLoad,
        })
      );
    });

    expect(scrollMock.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      viewPosition: 0,
      viewOffset: 1,
      animated: false,
    });
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('scrolls once the anchor arrives with a loaded older page', () => {
    const onLoad = vi.fn<() => void>();
    const renderer = mountResumeList({
      items: [resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
    });
    expect(onLoad).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.update(
        resumeElement({
          items: [resumeItem('msg-older'), resumeItem('msg-new')],
          resumeAt: 'msg-older',
          hasOlderMessages: true,
          onLoadOlderMessages: onLoad,
        })
      );
    });

    expect(scrollMock.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      viewPosition: 0,
      viewOffset: 1,
      animated: false,
    });
  });
});

// The list hands the host the viewport's position through `onAnchorChange`.
// These drive the FlashList `onViewableItemsChanged` prop directly, which is
// the same event FlashList raises on device.
type AnchorViewToken = { item: SessionTranscriptItem; index: number };

describe('SessionMessageList anchor reporting', () => {
  const anchorBaseProps = {
    sessionId: 'session-1',
    keyExtractor: (item: SessionTranscriptItem) => getSessionTranscriptItemKey(item),
    hasOlderMessages: false,
    isLoadingOlderMessages: false,
    olderMessagesError: null,
    olderMessagesOmittedItemCount: 0,
    onLoadOlderMessages: () => undefined,
    renderItem: () => null,
  };

  type AnchorProps = Parameters<typeof SessionMessageList<SessionTranscriptItem>>[0];

  function mountAnchorList(overrides: Partial<AnchorProps>): void {
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    act(() => {
      ref.current = TestRenderer.create(
        createElement(SessionMessageList<SessionTranscriptItem>, {
          ...anchorBaseProps,
          ...overrides,
          items: overrides.items ?? [],
        })
      );
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }
    mounted.push(renderer);
  }

  function fireViewability(tokens: readonly AnchorViewToken[]): void {
    const handler = flashListProps.current?.onViewableItemsChanged as
      | ((info: { viewableItems: unknown[] }) => void)
      | undefined;
    if (handler === undefined) {
      throw new Error('viewability callback is not wired');
    }
    act(() => {
      handler({
        viewableItems: tokens.map(token => ({
          item: token.item,
          index: token.index,
          key: `row-${token.index}`,
          isViewable: true,
          timestamp: 0,
        })),
      });
    });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('wires viewability only when the host asked for the position', () => {
    mountAnchorList({ items: [resumeItem('msg-1')] });
    expect(flashListProps.current?.viewabilityConfig).toBeUndefined();
    expect(flashListProps.current?.onViewableItemsChanged).toBeUndefined();

    mountAnchorList({
      items: [resumeItem('msg-1')],
      onAnchorChange: vi.fn<(id: string) => void>(),
    });
    expect(flashListProps.current?.viewabilityConfig).toEqual({
      itemVisiblePercentThreshold: 50,
    });
    expect(typeof flashListProps.current?.onViewableItemsChanged).toBe('function');
  });

  it('reports the topmost viewable row message id', () => {
    const onAnchorChange = vi.fn<(messageId: string) => void>();
    const first = resumeItem('msg-1');
    const second = resumeItem('msg-2');
    mountAnchorList({ items: [first, second], onAnchorChange });

    // FlashList's token array is not guaranteed to be index-ordered: the
    // topmost row is the lowest index, not the first array entry.
    fireViewability([
      { item: second, index: 1 },
      { item: first, index: 0 },
    ]);

    expect(onAnchorChange).toHaveBeenCalledTimes(1);
    expect(onAnchorChange).toHaveBeenCalledWith('msg-1');
  });

  it('reports nothing while the topmost viewable row is unchanged', () => {
    const onAnchorChange = vi.fn<(messageId: string) => void>();
    const first = resumeItem('msg-1');
    const second = resumeItem('msg-2');
    mountAnchorList({ items: [first, second], onAnchorChange });

    fireViewability([{ item: first, index: 0 }]);
    fireViewability([{ item: first, index: 0 }]);

    expect(onAnchorChange).toHaveBeenCalledTimes(1);
  });

  it('coalesces changes to one report per second and publishes the settled value', () => {
    vi.useFakeTimers();
    const onAnchorChange = vi.fn<(messageId: string) => void>();
    const first = resumeItem('msg-1');
    const second = resumeItem('msg-2');
    mountAnchorList({ items: [first, second], onAnchorChange });

    fireViewability([{ item: first, index: 0 }]);
    expect(onAnchorChange).toHaveBeenLastCalledWith('msg-1');

    // A scroll that immediately moves the viewport on must not report per
    // event; the trailing report carries the position the viewport settled on.
    fireViewability([{ item: second, index: 1 }]);
    expect(onAnchorChange).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onAnchorChange).toHaveBeenCalledTimes(2);
    expect(onAnchorChange).toHaveBeenLastCalledWith('msg-2');
  });

  it('drops a scheduled report when the viewport settles back on the last reported row', () => {
    vi.useFakeTimers();
    const onAnchorChange = vi.fn<(messageId: string) => void>();
    const first = resumeItem('msg-1');
    const second = resumeItem('msg-2');
    mountAnchorList({ items: [first, second], onAnchorChange });

    fireViewability([{ item: first, index: 0 }]);
    expect(onAnchorChange).toHaveBeenCalledTimes(1);
    expect(onAnchorChange).toHaveBeenLastCalledWith('msg-1');

    // The viewport moves on, scheduling a trailing report for `msg-2`...
    fireViewability([{ item: second, index: 1 }]);
    expect(onAnchorChange).toHaveBeenCalledTimes(1);

    // ...then settles back onto the row the host already knows about before
    // the timer fires. The scheduled report must publish nothing: reporting
    // `msg-2` would tell the host the user is looking at a row they scrolled
    // away from and put that stale position in the resume link.
    fireViewability([{ item: first, index: 0 }]);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onAnchorChange).toHaveBeenCalledTimes(1);
  });
});
