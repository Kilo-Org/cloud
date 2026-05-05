export const MESSAGE_LIST_KEYBOARD_SCROLL_RETRY_DELAY_MS = 80;

type ScrollToOffsetParams = {
  animated: boolean;
  offset: number;
};

type MessageListKeyboardScrollSchedulerParams = {
  getScrollOffset: () => number;
  scrollToOffset: (params: ScrollToOffsetParams) => void;
};

export function createMessageListKeyboardScrollScheduler({
  getScrollOffset,
  scrollToOffset,
}: MessageListKeyboardScrollSchedulerParams) {
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;

  const clearRetry = () => {
    if (retryTimeout !== null) {
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }
  };

  const scrollToMaintainedPosition = (offset: number) => {
    scrollToOffset({ animated: true, offset });
  };

  return {
    cancel: clearRetry,
    schedule: (keyboardHeight: number) => {
      clearRetry();
      const maintainedOffset = getScrollOffset() + keyboardHeight;
      scrollToMaintainedPosition(maintainedOffset);
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        scrollToMaintainedPosition(maintainedOffset);
      }, MESSAGE_LIST_KEYBOARD_SCROLL_RETRY_DELAY_MS);
    },
  };
}
