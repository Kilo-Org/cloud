/**
 * The transcript's newest-message follow.
 *
 * A scroll-to-end issued while the list is still measuring lands short — the
 * first call runs before the appended row has a height, so the viewport stops
 * above the message the user just sent or received. Schedule the scroll twice:
 * once now, once after the row has had a frame to measure.
 *
 * The keyboard lift is not here: the conversation screen's `KeyboardAvoidingView`
 * (`react-native-keyboard-controller`) shrinks the list's viewport while the
 * IME moves, and the list follows the newest message when its viewport shrinks.
 */
export const MESSAGE_LIST_NEWEST_SCROLL_RETRY_DELAY_MS = 80;

type ScrollToEndParams = {
  animated: boolean;
};

type MessageListNewestScrollSchedulerParams = {
  scrollToEnd: (params: ScrollToEndParams) => void;
};

export function createMessageListNewestScrollScheduler({
  scrollToEnd,
}: MessageListNewestScrollSchedulerParams) {
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimeout !== null) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
  };

  const scrollToNewest = () => {
    scrollToEnd({ animated: true });
  };

  return {
    cancel: clearRetry,
    schedule: () => {
      clearRetry();
      scrollToNewest();
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        scrollToNewest();
      }, MESSAGE_LIST_NEWEST_SCROLL_RETRY_DELAY_MS);
    },
  };
}
