import { FlashList, type ListRenderItem } from '@shopify/flash-list';
import { type OlderMessagesError } from '@kilocode/cloud-agent-sdk';
import { ChevronDown } from '@/components/ui/icons';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  AccessibilityInfo,
  Keyboard,
  Platform,
  Pressable,
  View,
  type ViewStyle,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSessionListAutoScroll } from '@/components/agents/use-session-list-auto-scroll';
import { useSessionListAnchorReport } from '@/components/agents/use-session-list-anchor-report';
import { useSessionListResumeScroll } from '@/components/agents/use-session-list-resume-scroll';
import { SessionPaginationHeader } from '@/components/agents/session-pagination-header';
import { shouldTriggerOlderMessagesLoad } from '@/components/agents/session-message-list-state';
import {
  getSessionTranscriptItemMessageId,
  type SessionTranscriptItem,
} from '@/components/agents/session-transcript';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  getOlderMessagesArrivedAnnouncement,
  shouldAnnounceOlderMessagesArrival,
} from '@/components/agents/older-messages-a11y';

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingVertical: 8 } satisfies ViewStyle;

// Prevent `onStartReached` from firing while an older page is already in
// flight. The manager dedupes too, but the UI guard keeps us from issuing
// repeated `onStartReached` callbacks during a single drag, which would
// otherwise spam the FlashList event log.
const ON_START_REACHED_THRESHOLD = 2;

const DRAW_DISTANCE = 1000;

type SessionMessageListProps<T> = {
  sessionId: string;
  items: readonly T[];
  keyExtractor: (item: T) => string;
  getItemType?: (item: T) => string;
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  olderMessagesOmittedItemCount: number;
  onLoadOlderMessages: () => void;
  renderItem: ListRenderItem<T>;
  ListFooterComponent?: React.ComponentType | React.ReactElement | null;
  /**
   * Message id a `?at=` deep link wants the transcript to open on. When it is
   * a rendered row the list scrolls to it once; when it lives in an older page
   * the list loads pages up to a bound and re-plans. Absent/null keeps every
   * existing caller byte-identical, and an anchor the session no longer has
   * scrolls nothing and blanks nothing.
   */
  resumeAt?: string | null;
  /**
   * A send takes the transcript position over. The host bumps this counter on
   * every send (the composer's prompt or slash-command path): the list ends
   * any in-flight `?at=` resume, re-arms the tail follow and scrolls to the
   * newest row, so the sent message and its reply are on screen even when the
   * transcript was parked on an older anchor with follow off. Absent or
   * unchanged keeps every existing caller byte-identical.
   */
  followTailNonce?: number;
  /**
   * Optional callback fired when the topmost viewable row's message changes.
   * The host publishes it as the session's position (route search params and
   * the OS handoff entry point). Absent keeps every existing caller
   * byte-identical: no viewability wiring is attached at all.
   */
  onAnchorChange?: (messageId: string) => void;
  /**
   * Extra bottom padding (in dp) applied to the list's content container.
   * The default (undefined) keeps the legacy `paddingVertical: 8` behavior
   * exactly, so the main session view is unaffected. Hosts that render
   * inside a React Native `Modal` (e.g. the subagent sheet) pass a
   * safe-area-aware value so the last row clears curved-bottom home
   * indicators.
   */
  contentBottomInset?: number;
  /**
   * Optional callback fired when the list returns to the bottom after the
   * user scrolled away. Fires only on the false→true transition of
   * `isAtBottom`, never on mount. The host uses this to trim retained
   * history exactly when the user returns to the live tail.
   */
  onReachedBottom?: () => void;
};

export function SessionMessageList<T>({
  sessionId,
  items,
  keyExtractor,
  getItemType,
  hasOlderMessages,
  isLoadingOlderMessages,
  olderMessagesError,
  olderMessagesOmittedItemCount,
  onLoadOlderMessages,
  renderItem,
  ListFooterComponent,
  contentBottomInset,
  onReachedBottom,
  onAnchorChange,
  resumeAt,
  followTailNonce,
}: Readonly<SessionMessageListProps<T>>) {
  // Rows are already present when the list mounts (the resume never mounts a
  // blank list), so the resume decision is derivable at render: every row's
  // anchor id via `getSessionTranscriptItemMessageId`, and whether the anchor
  // is one of them.
  const anchorIds = useMemo(
    () => items.map(item => getSessionTranscriptItemMessageId(item as SessionTranscriptItem)),
    [items]
  );
  const resumeAnchor =
    resumeAt !== undefined && resumeAt !== null && resumeAt.trim().length > 0
      ? resumeAt.trim()
      : null;
  // Follow the newest message at mount exactly as before UNLESS the resume has
  // work to do: an anchor that is already a row (scroll), or one that may still
  // arrive with an older page (load-older). An anchor the session no longer has
  // and no older history to search keeps the list byte-identical to an
  // anchor-less open — at the bottom, following the tail.
  const anchorIsRow = resumeAnchor !== null && anchorIds.includes(resumeAnchor);
  const followTailAtMount = !(anchorIsRow || (resumeAnchor !== null && hasOlderMessages));
  // FlashList v2 renders the list in chronological order (oldest → newest).
  // `startRenderingFromBottom` keeps the viewport anchored at the newest
  // message on first render and after prepended older pages, which is the
  // exact behavior we want for the agent session transcript.
  const {
    isAtBottom,
    listRef,
    scrollToLatestAnimated,
    suppressAutoFollow,
    isUserScrollingRef,
    userInteractedRef,
    sendTakeoverRef,
    followTailFromSend,
    handleContentSizeChange,
    handleKeyboardShow,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
  } = useSessionListAutoScroll<T>({
    itemCount: items.length,
    resetKey: sessionId,
    initialAutoScroll: followTailAtMount,
    resumeKey: resumeAnchor,
  });
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { left, right } = useSafeAreaInsets();

  // Coalesce the trigger: only fire `onLoadOlderMessages` while there is
  // actually a cursor, we are not already loading, and we are not in a
  // terminal failure state. The manager enforces the same rules; this
  // prevents noisy re-fires from FlashList's onStartReached callback.
  const inFlightRef = useRef(false);
  const handleStartReached = useCallback(() => {
    if (
      !shouldTriggerOlderMessagesLoad({
        hasOlderMessages,
        isLoadingOlderMessages,
        isInFlight: inFlightRef.current,
        olderMessagesError,
      })
    ) {
      return;
    }
    inFlightRef.current = true;
    try {
      onLoadOlderMessages();
    } finally {
      // Microtask-deferred reset lets the manager's loading atom update
      // before the next onStartReached cycle.
      queueMicrotask(() => {
        inFlightRef.current = false;
      });
    }
  }, [hasOlderMessages, isLoadingOlderMessages, onLoadOlderMessages, olderMessagesError]);

  // Reset the in-flight guard whenever the session changes so a new
  // transcript doesn't inherit a stale lock.
  useEffect(() => {
    inFlightRef.current = false;
  }, [sessionId]);

  // Report the viewport's topmost message to the host. Absent `onAnchorChange`,
  // nothing is wired: no viewability callback, no config.
  const anchorReport = useSessionListAnchorReport<T>({ sessionId, onAnchorChange });

  // The host's send path takes the position over through the counter. A list
  // that mounts following the tail adopts the mount value as already handled:
  // an empty transcript receiving its first message follows the tail at mount,
  // so replaying an earlier send's take-over would be redundant. A list that
  // mounts NOT following the tail — a `?at=` resume still paging for its
  // anchor — must honour a counter the host already bumped, or a send issued
  // while the transcript was in the zero-item `older-loading` state (the list
  // was not mounted for the change) is dropped and the resume parks on the
  // recorded anchor with the sent message and its reply off-screen.
  //
  // Declared before the resume hook on purpose: effects run in declaration
  // order, so the take-over is in place when the resume plans this render. A
  // send must end the resume in the same commit it lands, not one render later.
  const handledFollowTailNonceRef = useRef(followTailAtMount ? followTailNonce : 0);
  useEffect(() => {
    if (followTailNonce === undefined) {
      return;
    }
    if (handledFollowTailNonceRef.current === followTailNonce) {
      return;
    }
    handledFollowTailNonceRef.current = followTailNonce;
    followTailFromSend();
  }, [followTailNonce, followTailFromSend]);

  // Resume-position scroll for a `?at=` deep link — see
  // `use-session-list-resume-scroll` for the plan, the page budget, and the
  // device-proven retry schedule.
  useSessionListResumeScroll<T>({
    sessionId,
    anchorIds,
    hasOlderMessages,
    isLoadingOlderMessages,
    olderMessagesError,
    onLoadOlderMessages,
    isInFlightRef: inFlightRef,
    listRef,
    isUserScrollingRef,
    userInteractedRef,
    sendTakeoverRef,
    suppressAutoFollow,
    resumeAt,
  });

  // Keep the newest message visible when the keyboard opens, but only while
  // the follow guard is true (the user is still at the bottom). On iOS,
  // `keyboardWillShow` fires before the animation and `keyboardDidShow` fires
  // after it: the first starts the scroll immediately and the second lands it
  // once the viewport has actually shrunk. Android has no will-show event, so
  // `keyboardDidShow` is the only show signal there.
  useEffect(() => {
    if (Platform.OS === 'ios') {
      const willShow = Keyboard.addListener('keyboardWillShow', handleKeyboardShow);
      const didShow = Keyboard.addListener('keyboardDidShow', handleKeyboardShow);
      return () => {
        willShow.remove();
        didShow.remove();
      };
    }
    const didShow = Keyboard.addListener('keyboardDidShow', handleKeyboardShow);
    return () => {
      didShow.remove();
    };
  }, [handleKeyboardShow]);

  // Fire `onReachedBottom` only on the false→true transition of
  // `isAtBottom`. The previous-value ref prevents a fire on mount (the list
  // starts at the bottom) and on repeat renders while already at the bottom.
  // The handler is held in a ref so a new inline callback identity from the
  // host never re-runs this effect.
  const onReachedBottomRef = useRef(onReachedBottom);
  onReachedBottomRef.current = onReachedBottom;
  const prevIsAtBottomRef = useRef(isAtBottom);
  useEffect(() => {
    const prev = prevIsAtBottomRef.current;
    prevIsAtBottomRef.current = isAtBottom;
    if (isAtBottom && !prev) {
      onReachedBottomRef.current?.();
    }
  }, [isAtBottom]);

  // Non-visual a11y signal for older-page arrival (visual loading skeleton
  // was removed). Announce only when items were actually prepended.
  const olderArrivalInitializedRef = useRef(false);
  const olderArrivalCountRef = useRef(0);
  const olderArrivalNewestKeyRef = useRef<string | null>(null);
  useEffect(() => {
    olderArrivalInitializedRef.current = false;
    olderArrivalCountRef.current = 0;
    olderArrivalNewestKeyRef.current = null;
  }, [sessionId]);
  useEffect(() => {
    const newestItem = items.at(-1);
    const nextNewestKey = newestItem === undefined ? null : keyExtractor(newestItem);
    const nextCount = items.length;
    if (
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: olderArrivalInitializedRef.current,
        previousCount: olderArrivalCountRef.current,
        nextCount,
        previousNewestKey: olderArrivalNewestKeyRef.current,
        nextNewestKey,
      })
    ) {
      AccessibilityInfo.announceForAccessibility(getOlderMessagesArrivedAnnouncement());
    }
    olderArrivalInitializedRef.current = true;
    olderArrivalCountRef.current = nextCount;
    olderArrivalNewestKeyRef.current = nextNewestKey;
  }, [items, keyExtractor]);

  // When the optional `contentBottomInset` is omitted and the landscape side
  // insets are 0 (portrait) we return the original module-level
  // `listContentContainerStyle` reference so the default-prop path is
  // behavior-identical (no allocation, no value change). When provided we
  // extend the bottom padding to clear safe areas such as the home indicator
  // on curved-bottom iPhones, and the side padding keeps transcript text clear
  // of the landscape sensor housing; portrait insets are 0, keeping the
  // geometry unchanged.
  const resolvedContentContainerStyle = useMemo<ViewStyle>(
    () =>
      !contentBottomInset && left === 0 && right === 0
        ? listContentContainerStyle
        : {
            paddingTop: 8,
            paddingBottom: 8 + (contentBottomInset ?? 0),
            paddingLeft: left,
            paddingRight: right,
          },
    [contentBottomInset, left, right]
  );

  return (
    <View className="flex-1">
      <FlashList<T>
        ref={listRef}
        style={listStyle}
        contentContainerStyle={resolvedContentContainerStyle}
        data={items}
        keyExtractor={keyExtractor}
        getItemType={getItemType}
        renderItem={renderItem}
        // Transcript rows are tall and parse markdown on mount. The 250 dp
        // default draws under half a screen ahead, so a fast fling shows blank
        // space until the rows mount. Four screens of lookahead hides that.
        drawDistance={DRAW_DISTANCE}
        // Android Fabric can race clipped-view reattachment with rapid transcript updates.
        // Kept explicit: flash-list ≥ 2.3.2 defaults this to false (PR #2202); the pin
        // is asserted in src/lib/flash-list-contract.test.ts.
        removeClippedSubviews={false}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        onContentSizeChange={handleContentSizeChange}
        onLayout={handleListLayout}
        scrollEventThrottle={16}
        onStartReached={hasOlderMessages ? handleStartReached : undefined}
        onStartReachedThreshold={ON_START_REACHED_THRESHOLD}
        // Viewability is only wired when a host asked for the position, so
        // every other caller's list stays byte-identical.
        {...anchorReport}
        maintainVisibleContentPosition={{
          // Start rendering from the bottom so the newest message is visible
          // on first render. `autoscrollToTopThreshold` is left at its default
          // so the viewport only repositions when the user is far enough away
          // from the top — preserving the existing auto-follow behavior on
          // streaming insertions at the bottom.
          startRenderingFromBottom: true,
        }}
        ListHeaderComponent={
          <SessionPaginationHeader
            isLoadingOlderMessages={isLoadingOlderMessages}
            olderMessagesError={olderMessagesError}
            olderMessagesOmittedItemCount={olderMessagesOmittedItemCount}
            onRetry={onLoadOlderMessages}
          />
        }
        ListFooterComponent={ListFooterComponent}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      />
      {/* Floating "scroll to bottom" affordance. Rendered only when the
          user has scrolled past the 100px bottom threshold; the fade
          animations match the chat-composer convention. `pointerEvents`
          is set on the wrapper so empty space around the button keeps
          scrolling the list, while the Pressable itself catches taps. */}
      {!isAtBottom ? (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          pointerEvents="box-none"
          className="absolute bottom-4 right-4"
          // The fixed 16pt (right-4) offset gains the landscape right inset so
          // the control clears the sensor area; portrait insets are 0, keeping
          // the geometry unchanged (16 == right-4).
          style={{ right: 16 + right }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('agentChat.session.scrollToBottom')}
            onPress={scrollToLatestAnimated}
            hitSlop={2}
            className="h-10 w-10 items-center justify-center rounded-full border border-border bg-card shadow-lg shadow-[#00000040] active:opacity-70"
          >
            <ChevronDown size={20} color={colors.foreground} />
          </Pressable>
        </Animated.View>
      ) : null}
    </View>
  );
}
