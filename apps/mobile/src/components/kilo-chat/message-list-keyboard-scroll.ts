export const MESSAGE_LIST_KEYBOARD_SCROLL_RETRY_DELAY_MS = 80;

type ScrollToOffsetParams = {
  animated: boolean;
  offset: number;
};

type ScrollToEndParams = {
  animated: boolean;
};

type MessageListKeyboardScrollSchedulerParams = {
  getScrollOffset: () => number;
  scrollToOffset: (params: ScrollToOffsetParams) => void;
};

type MessageListNewestScrollSchedulerParams = {
  scrollToEnd: (params: ScrollToEndParams) => void;
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
      }, MESSAGE_LIST_KEYBOARD_SCROLL_RETRY_DELAY_MS);
    },
  };
}
