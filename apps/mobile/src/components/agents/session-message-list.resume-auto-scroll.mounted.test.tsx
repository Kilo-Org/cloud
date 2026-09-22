/* eslint-disable max-lines -- one mounted harness drives the real auto-scroll and resume hooks for every resume/takeover case */
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

// The mounted FlashList's props, so a test can drive the scroll/content-size
// callbacks the real list emits as it renders from the bottom and measures rows.
let flashListProps: Record<string, unknown> | null = null;

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashListProps = props;
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
  const mounted = mountListKeep(overrides);
  // The 80ms safety-net retry of the auto-follow is the call that used to
  // override the resume; let it (and the 150ms programmatic-scroll window) pass.
  act(() => {
    vi.advanceTimersByTime(300);
  });
  return mounted;
}

function mountListKeep(overrides: Partial<ListProps>): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(SessionMessageList<SessionTranscriptItem>, {
        ...baseProps,
        ...overrides,
        items: overrides.items ?? [],
      })
    );
  });
  const mounted = ref.current;
  if (!mounted) {
    throw new Error('renderer was not created');
  }
  return mounted;
}

function updateList(mounted: TestRenderer.ReactTestRenderer, overrides: Partial<ListProps>): void {
  act(() => {
    mounted.update(
      createElement(SessionMessageList<SessionTranscriptItem>, {
        ...baseProps,
        ...overrides,
        items: overrides.items ?? [],
      })
    );
  });
}

/** The native drag callbacks FlashList raises, so a test can act as the user. */
function beginUserDrag(): void {
  (flashListProps?.onScrollBeginDrag as ((event: unknown) => void) | undefined)?.({
    nativeEvent: {},
  });
}

function endUserDrag(): void {
  (flashListProps?.onScrollEndDrag as ((event: unknown) => void) | undefined)?.({
    nativeEvent: {
      contentOffset: { x: 0, y: 0 },
      contentSize: { height: 900 },
      layoutMeasurement: { height: 300 },
    },
  });
}

function emitContentSizeChange(height: number): void {
  (flashListProps?.onContentSizeChange as ((width: number, height: number) => void) | undefined)?.(
    1000,
    height
  );
}

describe('SessionMessageList resume anchor vs tail auto-follow', () => {
  afterEach(() => {
    vi.useRealTimers();
    scrollCalls.length = 0;
    flashListProps = null;
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

  it('opens on the recorded row when the session already holds it', () => {
    vi.useFakeTimers();

    mountListKeep({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });

    // The mount run itself must not scroll: the first layout has not measured
    // its rows, so a mount-time scroll loses to FlashList's own bottom-start
    // initial scroll and to the estimate settle (device: an anchor at message
    // 30 settled on message 34 with message 30 still painted over it).
    expect(scrollCalls).toEqual([]);
    expect(flashListProps?.initialScrollIndex).toBeUndefined();
    expect(flashListProps?.maintainVisibleContentPosition).toEqual({
      startRenderingFromBottom: true,
    });

    // The bounded retries land after FlashList's own initial-scroll burst
    // drains, under the measured conditions the warm scroll is proven exact
    // under. The schedule runs to 2000ms because the bottom re-assertion
    // drains for over a second under the measurement load (device-proven).
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(scrollCalls).toEqual(['index:1']);
    act(() => {
      vi.advanceTimersByTime(1750);
    });
    expect(scrollCalls).toEqual(['index:1', 'index:1', 'index:1', 'index:1']);
  });

  it('keeps the bottom start for every open, anchored or not', () => {
    vi.useFakeTimers();

    mountList({ items: [resumeItem('msg-1'), resumeItem('msg-2')] });
    expect(flashListProps?.maintainVisibleContentPosition).toEqual({
      startRenderingFromBottom: true,
    });
    expect(flashListProps?.initialScrollIndex).toBeUndefined();

    // An anchor the session no longer has is the same anchor-less open.
    mountList({ items: [resumeItem('msg-1')], resumeAt: 'msg-gone' });
    expect(flashListProps?.maintainVisibleContentPosition).toEqual({
      startRenderingFromBottom: true,
    });
    expect(flashListProps?.initialScrollIndex).toBeUndefined();
  });

  it('scrolls immediately when an anchor arrives on a mounted list', () => {
    vi.useFakeTimers();

    const mounted = mountListKeep({ items: [resumeItem('msg-1'), resumeItem('msg-2')] });
    expect(scrollCalls).toEqual(['end']);

    // The route dedupes onto an already-mounted session screen and updates
    // its `at` param: the warm path. The rows are measured, so the scroll
    // runs at once — the device-proven exact landing — and the retries
    // re-affirm the same row.
    act(() => {
      mounted.update(
        createElement(SessionMessageList<SessionTranscriptItem>, {
          ...baseProps,
          items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
          resumeAt: 'msg-3',
        })
      );
    });
    expect(scrollCalls).toEqual(['end', 'index:2']);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(scrollCalls).toEqual(['end', 'index:2', 'index:2', 'index:2', 'index:2', 'index:2']);
  });

  it('skips a retry while the user is dragging', () => {
    vi.useFakeTimers();

    mountListKeep({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });
    expect(scrollCalls).toEqual([]);

    // The user grabs the list before the first retry fires: the resume must
    // never yank the list out of their drag.
    act(() => {
      (flashListProps?.onScrollBeginDrag as ((event: unknown) => void) | undefined)?.({
        nativeEvent: {},
      });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(scrollCalls).toEqual([]);
  });

  it('cancels the resume chain once the user has grabbed the transcript', () => {
    vi.useFakeTimers();

    mountListKeep({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });

    // The first retry lands the anchor.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(scrollCalls).toEqual(['index:1']);

    // The user takes over and lets go: the position is theirs now. The
    // remaining retries must cancel themselves instead of pulling the list
    // back to the recorded row after the drag ends.
    act(() => {
      (flashListProps?.onScrollBeginDrag as ((event: unknown) => void) | undefined)?.({
        nativeEvent: {},
      });
      (flashListProps?.onScrollEndDrag as ((event: unknown) => void) | undefined)?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 0 },
          contentSize: { height: 900 },
          layoutMeasurement: { height: 300 },
        },
      });
    });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(scrollCalls).toEqual(['index:1']);
  });

  it('does not follow the tail when bottom-start scroll events arrive during the settle', () => {
    vi.useFakeTimers();

    mountListKeep({
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-2',
    });

    // FlashList's own bottom-start initial scroll lands the viewport on the
    // newest row; its native scroll event arrives after the mount commit,
    // and rows keep finishing their measurement afterwards (content-size
    // changes). None of that may arm the tail follow: the follow's
    // content-size path scrolls to the end directly, and a cold open with it
    // armed never holds the resume (device: every such open settled 59/60).
    act(() => {
      vi.advanceTimersByTime(50);
      (flashListProps?.onScroll as ((event: unknown) => void) | undefined)?.({
        nativeEvent: {
          contentOffset: { x: 0, y: 2000 },
          contentSize: { height: 3000 },
          layoutMeasurement: { height: 1000 },
        },
      });
      (
        flashListProps?.onContentSizeChange as ((width: number, height: number) => void) | undefined
      )?.(1000, 3100);
    });
    expect(scrollCalls).toEqual([]);

    // The retries then land the anchor and it holds: the only programmatic
    // scrolls left are the resume's own.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(scrollCalls).toEqual(['index:1']);
  });

  it('leaves the bottom start in place when there is no anchor', () => {
    vi.useFakeTimers();

    mountList({ items: [resumeItem('msg-1'), resumeItem('msg-2')] });
    expect(flashListProps?.initialScrollIndex).toBeUndefined();
  });

  it('leaves the bottom start in place when the anchor is gone', () => {
    vi.useFakeTimers();

    // An anchor the session no longer has is the same anchor-less open.
    mountList({ items: [resumeItem('msg-1')], resumeAt: 'msg-gone' });
    expect(flashListProps?.initialScrollIndex).toBeUndefined();
  });

  it('keeps the bottom start when the anchor waits in an older page', () => {
    vi.useFakeTimers();

    mountList({
      items: [resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: vi.fn<() => void>(),
    });

    // The row is not loaded yet: the page has to arrive first, and the resume
    // scroll runs on the items that land.
    expect(flashListProps?.initialScrollIndex).toBeUndefined();
  });

  it('does not scroll when the anchor arrives while the user is dragging', () => {
    vi.useFakeTimers();

    const mounted = mountListKeep({ items: [resumeItem('msg-1'), resumeItem('msg-2')] });
    expect(scrollCalls).toEqual(['end']);
    scrollCalls.length = 0;

    // The user is mid-drag when the anchor's older page lands. The immediate
    // warm scroll must honour the same guard its retries do, or the list is
    // yanked out of the user's hands.
    act(() => {
      beginUserDrag();
    });
    updateList(mounted, {
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-3',
    });
    expect(scrollCalls).toEqual([]);

    // The takeover cancels the retry chain too: nothing pulls the list back
    // after the drag ends.
    act(() => {
      endUserDrag();
      vi.advanceTimersByTime(2000);
    });
    expect(scrollCalls).toEqual([]);
  });

  it('does not scroll when the anchor arrives after the user has grabbed the transcript', () => {
    vi.useFakeTimers();

    const mounted = mountListKeep({ items: [resumeItem('msg-1'), resumeItem('msg-2')] });
    expect(scrollCalls).toEqual(['end']);
    scrollCalls.length = 0;

    act(() => {
      beginUserDrag();
      endUserDrag();
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // The route updates `at` on the already-mounted screen: the sticky takeover
    // outranks the resume.
    updateList(mounted, {
      items: [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')],
      resumeAt: 'msg-3',
    });
    expect(scrollCalls).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(scrollCalls).toEqual([]);
  });

  it('keeps the user takeover when the follow policy flips mid-session', () => {
    vi.useFakeTimers();

    const onLoad = vi.fn<() => void>();
    const mounted = mountListKeep({
      items: [resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
    });
    expect(onLoad).toHaveBeenCalledTimes(1);
    scrollCalls.length = 0;

    // The user takes over while the anchor's older page is in flight.
    act(() => {
      beginUserDrag();
      endUserDrag();
    });
    act(() => {
      vi.advanceTimersByTime(150);
    });

    // The older pages run out without the anchor, so `followTailAtMount` flips
    // to true mid-session. That must not clear the takeover flag nor re-arm the
    // tail follow: the user's position is theirs.
    updateList(mounted, {
      items: [resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: false,
      onLoadOlderMessages: onLoad,
    });

    // A streamed content-size growth must not pull the list back to the tail.
    emitContentSizeChange(3100);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(scrollCalls).toEqual([]);
  });

  it('ends the resume and follows the tail when the host sends from a resumed position', () => {
    vi.useFakeTimers();

    const items = [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')];
    const mounted = mountListKeep({ items, resumeAt: 'msg-2' });

    // The resume lands the anchor through its retry chain.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(scrollCalls).toEqual(['index:1']);

    // The user sends: the host bumps the counter. The transcript must follow
    // the output the send produces instead of staying parked on the anchor.
    updateList(mounted, { items, resumeAt: 'msg-2', followTailNonce: 1 });
    expect(scrollCalls).toEqual(['index:1', 'end']);

    // The remaining resume retries cancel themselves: nothing pulls the list
    // back to the recorded row once the send has taken the position over.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(scrollCalls).toEqual(['index:1', 'end', 'end']);

    // The follow stays armed for the rows the send produces.
    emitContentSizeChange(3100);
    expect(scrollCalls).toEqual(['index:1', 'end', 'end', 'end']);
  });

  it('takes over a resume that is still paging for its anchor', () => {
    vi.useFakeTimers();

    const onLoad = vi.fn<() => void>();
    const mounted = mountListKeep({
      items: [resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
    });
    expect(onLoad).toHaveBeenCalledTimes(1);

    // The user sends while the anchor's page is still in flight.
    updateList(mounted, {
      items: [resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
      followTailNonce: 1,
    });
    expect(scrollCalls).toEqual(['end']);

    // The page lands: the resume's warm scroll and its retry chain must drop,
    // because the position belongs to the send now.
    updateList(mounted, {
      items: [resumeItem('msg-older'), resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
      followTailNonce: 1,
    });
    expect(scrollCalls).toEqual(['end']);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(scrollCalls).toEqual(['end', 'end']);
  });

  it('ends a paging resume when the host sends', () => {
    vi.useFakeTimers();

    const onLoad = vi.fn<() => void>();
    const items = [resumeItem('msg-new')];
    const mounted = mountListKeep({
      items,
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
    });
    expect(onLoad).toHaveBeenCalledTimes(1);
    scrollCalls.length = 0;

    // The user sends while the anchor's page is in flight.
    updateList(mounted, {
      items,
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
      followTailNonce: 1,
    });
    expect(scrollCalls).toEqual(['end']);

    // The page lands without the anchor: the resume is over, so it must not
    // pull another page behind the send's back.
    updateList(mounted, {
      items: [resumeItem('msg-still-not-there'), resumeItem('msg-new')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: onLoad,
      followTailNonce: 1,
    });
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(scrollCalls).toEqual(['end']);
  });

  it('opens a later ?at= anchor after a send has taken the position over', () => {
    vi.useFakeTimers();

    const items = [resumeItem('msg-1'), resumeItem('msg-2'), resumeItem('msg-3')];
    const mounted = mountListKeep({ items, resumeAt: 'msg-2' });

    // The resume lands the anchor through its retry chain.
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(scrollCalls).toEqual(['index:1']);
    scrollCalls.length = 0;

    // The user sends: the send's output owns the position.
    updateList(mounted, { items, resumeAt: 'msg-2', followTailNonce: 1 });
    expect(scrollCalls).toEqual(['end']);
    scrollCalls.length = 0;

    // The route then updates `at` on the same mounted screen. A send does not
    // claim the session's position, so the new link resumes again instead of
    // being swallowed by the send's take-over.
    updateList(mounted, { items, resumeAt: 'msg-1', followTailNonce: 1 });
    expect(scrollCalls).toEqual(['index:0']);

    // The tail follow is off again for the resumed position: a streamed
    // content-size growth must not pull the list back to the bottom.
    emitContentSizeChange(3100);
    expect(scrollCalls).toEqual(['index:0']);
  });

  it('does not replay an earlier send when the list mounts following the tail', () => {
    vi.useFakeTimers();

    // A counter the host already holds at mount (the list rendered after the
    // send, e.g. an empty transcript that just received its first message) is
    // adopted as handled when the mount follows the tail anyway: the mount
    // follow alone runs.
    mountList({ items: [resumeItem('msg-1')], followTailNonce: 3 });

    expect(scrollCalls).toEqual(['end', 'end']);
  });

  it('takes over when the list mounts after a send from the zero-item older-loading state', () => {
    vi.useFakeTimers();

    // The transcript was zero-item and paging for a `?at=` anchor (the
    // `older-loading` view, so this list was not mounted) when the user hit
    // Send, and the host already holds the bumped counter. The list mounts for
    // the sent row NOT following the tail: it must honour the take-over instead
    // of adopting the mount value and parking on the recorded anchor.
    mountList({
      items: [resumeItem('msg-sent')],
      resumeAt: 'msg-older',
      hasOlderMessages: true,
      onLoadOlderMessages: vi.fn<() => void>(),
      followTailNonce: 1,
    });

    // `scrollToEnd` wins and stays armed for the reply the send produces: the
    // position is the send's, never the recorded anchor's.
    expect(scrollCalls).toEqual(['end', 'end']);
    emitContentSizeChange(3100);
    expect(scrollCalls).toEqual(['end', 'end', 'end']);

    // The resume retry chain drops instead of re-parking on the anchor.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(scrollCalls.filter(call => call.startsWith('index:'))).toEqual([]);
  });
});
