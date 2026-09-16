/* eslint-disable max-lines -- the landscape-inset suite and the resume-anchor suite share this file's mocked FlashList and auto-scroll harness. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionMessageList } from './session-message-list';
import { getSessionTranscriptItemKey, type SessionTranscriptItem } from './session-transcript';
import { MAX_RESUME_OLDER_LOADS } from '@/lib/session-resume';
import { stubTextPart, stubUserMessage } from '@kilocode/cloud-agent-sdk/test-helpers';

const flashListProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const controls = vi.hoisted(() => ({
  isAtBottom: true,
  leftInset: 0,
  rightInset: 0,
  scrollToIndex: vi.fn(),
  autoScrollParams: null as Record<string, unknown> | null,
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
  useSessionListAutoScroll: (params: Record<string, unknown>) => {
    controls.autoScrollParams = params;
    return {
      isAtBottom: controls.isAtBottom,
      listRef: { current: { scrollToIndex: controls.scrollToIndex } },
      scrollToLatestAnimated: vi.fn(),
      handleContentSizeChange: vi.fn(),
      handleKeyboardShow: vi.fn(),
      handleListLayout: vi.fn(),
      handleScroll: vi.fn(),
      handleScrollBeginDrag: vi.fn(),
      handleScrollEndDrag: vi.fn(),
      handleMomentumScrollBegin: vi.fn(),
      handleMomentumScrollEnd: vi.fn(),
    };
  },
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
    controls.scrollToIndex.mockClear();
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
  const baseProps = {
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
      ...baseProps,
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
    return renderer;
  }

  afterEach(() => {
    controls.scrollToIndex.mockClear();
    controls.autoScrollParams = null;
  });

  it('opens without tail auto-follow so the resume scroll is not overridden', () => {
    mountResumeList({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });

    // The mount-time scroll to the newest message (and its 80ms retry) would
    // otherwise discard the resume position before the user sees it.
    expect(controls.autoScrollParams?.initialAutoScroll).toBe(false);
  });

  it('keeps tail auto-follow for a session opened without an anchor', () => {
    mountResumeList({ items: [resumeItem('msg-1')] });
    expect(controls.autoScrollParams?.initialAutoScroll).toBe(true);

    mountResumeList({ items: [resumeItem('msg-1')], resumeAt: '' });
    expect(controls.autoScrollParams?.initialAutoScroll).toBe(true);
  });

  it('scrolls to the anchor row index once the rows are present', () => {
    mountResumeList({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });

    expect(controls.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 1,
      viewPosition: 0,
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

    expect(controls.scrollToIndex).not.toHaveBeenCalled();
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
    expect(controls.scrollToIndex).not.toHaveBeenCalled();
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

    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      viewPosition: 0,
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

    expect(controls.scrollToIndex).toHaveBeenCalledWith({
      index: 0,
      viewPosition: 0,
      animated: false,
    });
  });
});
