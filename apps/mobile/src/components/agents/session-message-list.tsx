import { FlashList, type FlashListRef, type ListRenderItem } from '@shopify/flash-list';
import { type OlderMessagesError } from 'cloud-agent-sdk';
import { useCallback, useEffect, useRef } from 'react';
import { type ViewStyle } from 'react-native';

import { useSessionListAutoScroll } from '@/components/agents/use-session-list-auto-scroll';
import { SessionPaginationHeader } from '@/components/agents/session-pagination-header';
import { shouldTriggerOlderMessagesLoad } from '@/components/agents/session-message-list-state';

const listStyle = { flex: 1 } satisfies ViewStyle;
const listContentContainerStyle = { paddingVertical: 8 } satisfies ViewStyle;

// Prevent `onStartReached` from firing while an older page is already in
// flight. The manager dedupes too, but the UI guard keeps us from issuing
// repeated `onStartReached` callbacks during a single drag, which would
// otherwise spam the FlashList event log.
const ON_START_REACHED_THRESHOLD = 0.5;

type SessionMessageListProps<T> = {
  sessionId: string;
  items: readonly T[];
  keyExtractor: (item: T) => string;
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  olderMessagesOmittedItemCount: number;
  onLoadOlderMessages: () => void;
  renderItem: ListRenderItem<T>;
  ListFooterComponent?: React.ComponentType | React.ReactElement | null;
};

export function SessionMessageList<T>({
  sessionId,
  items,
  keyExtractor,
  hasOlderMessages,
  isLoadingOlderMessages,
  olderMessagesError,
  olderMessagesOmittedItemCount,
  onLoadOlderMessages,
  renderItem,
  ListFooterComponent,
}: Readonly<SessionMessageListProps<T>>) {
  // FlashList v2 renders the list in chronological order (oldest → newest).
  // `startRenderingFromBottom` keeps the viewport anchored at the newest
  // message on first render and after prepended older pages, which is the
  // exact behavior we want for the agent session transcript.
  const {
    listRef,
    handleContentSizeChange,
    handleListLayout,
    handleScroll,
    handleScrollBeginDrag,
    handleScrollEndDrag,
    handleMomentumScrollBegin,
    handleMomentumScrollEnd,
  } = useSessionListAutoScroll<T>({
    itemCount: items.length,
    resetKey: sessionId,
  });

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

  // Defensive: the structural list ref is required by the hook but
  // downstream types may infer it as nullable.
  const listRefSafe = listRef as unknown as React.RefObject<FlashListRef<T>>;

  return (
    <FlashList<T>
      ref={listRefSafe}
      style={listStyle}
      contentContainerStyle={listContentContainerStyle}
      data={items}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
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
  );
}
