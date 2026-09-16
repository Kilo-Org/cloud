/**
 * Resume scroll vs. tail auto-follow, driven through the REAL auto-scroll hook
 * (unlike `session-message-list.mounted.test.tsx`, which mocks it).
 *
 * A `?at=` resume opens on an older row. The auto-follow would otherwise
 * scroll the viewport to the newest message at mount AND again on its 80ms
 * safety-net retry, discarding the resume position before the user sees it.
 * These tests pin the call order on the list ref: the resume scroll is the
 * last programmatic scroll, and a list opened without an anchor still follows
 * the tail exactly as before.
 */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionMessageList } from './session-message-list';
import { getSessionTranscriptItemKey, type SessionTranscriptItem } from './session-transcript';
import { stubTextPart, stubUserMessage } from '@kilocode/cloud-agent-sdk/test-helpers';

const scrollCalls: string[] = [];

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    const ref = props.ref as { current: unknown } | undefined;
    if (ref) {
      ref.current = {
        scrollToIndex: (args: { index: number }) => scrollCalls.push(`index:${args.index}`),
        scrollToEnd: () => scrollCalls.push('end'),
      };
    }
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
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  // The real motion policy (`@/lib/a11y/motion`) is loaded below; these are its
  // reanimated imports, kept minimal for the node-mounted harness.
  ReducedMotionConfig: () => null,
  ReduceMotion: { Always: 'always', Never: 'never', System: 'system' },
  useReducedMotion: () => false,
}));
// `a11y/motion` imports expo-battery, which the node-mounted harness cannot
// load (expo-modules-core reads `__DEV__`). Mock the native module, not the
// policy, so the list's own motion wiring stays real.
vi.mock('expo-battery', () => ({
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3, NOT_CHARGING: 4 },
  useBatteryLevel: () => 1,
  useBatteryState: () => 3,
}));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: 'black' }),
}));
vi.mock('@/components/agents/session-pagination-header', () => ({
  SessionPaginationHeader: () => null,
}));

function resumeItem(id: string): SessionTranscriptItem {
  return {
    type: 'message',
    message: {
      info: stubUserMessage({ id, sessionID: 'session-1' }),
      parts: [stubTextPart({ id: `${id}:text`, sessionID: 'session-1', messageID: id })],
    },
  };
}

type ListProps = Parameters<typeof SessionMessageList<SessionTranscriptItem>>[0];

// Every required prop, so a `Partial` override spread still satisfies the list.
const baseProps = {
  sessionId: 'session-1',
  keyExtractor: (item: SessionTranscriptItem) => getSessionTranscriptItemKey(item),
  hasOlderMessages: false,
  isLoadingOlderMessages: false,
  olderMessagesError: null,
  olderMessagesOmittedItemCount: 0,
  onLoadOlderMessages: () => undefined,
  renderItem: () => null,
} satisfies Omit<ListProps, 'items'>;

function mountList(overrides: Partial<ListProps>) {
  act(() => {
    TestRenderer.create(
      createElement(SessionMessageList<SessionTranscriptItem>, {
        ...baseProps,
        ...overrides,
        items: overrides.items ?? [],
      })
    );
  });
  // The 80ms safety-net retry of the auto-follow is the call that used to
  // override the resume; let it (and the 150ms programmatic-scroll window) pass.
  act(() => {
    vi.advanceTimersByTime(300);
  });
}

describe('SessionMessageList resume anchor vs tail auto-follow', () => {
  afterEach(() => {
    vi.useRealTimers();
    scrollCalls.length = 0;
  });

  it('keeps the resume scroll as the last programmatic scroll', () => {
    vi.useFakeTimers();

    mountList({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });

    expect(scrollCalls).toEqual(['index:1']);
  });

  it('still follows the tail when the session opens without an anchor', () => {
    vi.useFakeTimers();

    mountList({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
    });

    // The mount scroll to the newest message, then its retry — unchanged for
    // every caller that does not pass `resumeAt`.
    expect(scrollCalls).toEqual(['end', 'end']);
  });

  it('still follows the tail when the anchor is gone and no older history exists', () => {
    vi.useFakeTimers();

    // An unusable `at` is not an error: the open is byte-identical to one
    // without an anchor — mounted at the tail and still following it.
    mountList({ items: [resumeItem('msg-1')], resumeAt: 'msg-gone' });

    expect(scrollCalls).toEqual(['end', 'end']);
  });

  it('requests older pages without following the tail when the anchor is not loaded yet', () => {
    vi.useFakeTimers();
    const onLoad = vi.fn<() => void>();

    mountList({
      items: [resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
    });

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(scrollCalls).toEqual([]);
  });
});
