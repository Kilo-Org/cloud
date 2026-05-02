import {
  finishMarkReadAttempt,
  type MarkReadState,
  shouldStartMarkReadAttempt,
  startMarkReadAttempt,
  succeedMarkReadAttempt,
} from '@kilocode/kilo-chat-hooks';

export const MARK_READ_RETRY_LIMIT = 3;
export const MARK_READ_RETRY_DELAY_MS = 250;

type MarkReadRetryState = {
  marker: string | null;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export function createMarkReadRetryState(): MarkReadRetryState {
  return {
    marker: null,
    attempts: 0,
    timer: null,
  };
}

export function clearMarkReadRetry(state: MarkReadRetryState): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
  }
  state.marker = null;
  state.attempts = 0;
  state.timer = null;
}

export function scheduleMarkReadRetry(
  state: MarkReadRetryState,
  params: {
    marker: string;
    currentMarker: () => string | null;
    activeAndFocused: () => boolean;
    lastSucceededMarker: () => string | null;
    retry: () => void;
  }
): void {
  if (params.lastSucceededMarker() === params.marker) {
    clearMarkReadRetry(state);
    return;
  }

  if (state.marker !== params.marker) {
    clearMarkReadRetry(state);
    state.marker = params.marker;
  }

  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  if (state.attempts >= MARK_READ_RETRY_LIMIT) {
    return;
  }

  state.attempts += 1;
  const delayMs = MARK_READ_RETRY_DELAY_MS * state.attempts;
  state.timer = setTimeout(() => {
    state.timer = null;
    if (
      state.marker !== params.marker ||
      params.currentMarker() !== params.marker ||
      !params.activeAndFocused() ||
      params.lastSucceededMarker() === params.marker
    ) {
      return;
    }
    params.retry();
  }, delayMs);
}

export async function attemptMarkCurrentConversationRead(params: {
  marker: string;
  markReadState: MarkReadState;
  retryState: MarkReadRetryState;
  currentMarker: () => string | null;
  activeAndFocused: () => boolean;
  markRead: () => Promise<unknown>;
  retry: () => void;
}): Promise<void> {
  const { marker, markReadState, retryState } = params;
  if (!shouldStartMarkReadAttempt(markReadState, marker)) {
    return;
  }

  startMarkReadAttempt(markReadState, marker);
  try {
    await params.markRead();
    succeedMarkReadAttempt(markReadState, marker);
    clearMarkReadRetry(retryState);
  } catch {
    // useMarkRead already surfaces the mutation error to the user.
  } finally {
    finishMarkReadAttempt(markReadState, marker);
    if (markReadState.lastSucceededMarker !== marker) {
      scheduleMarkReadRetry(retryState, {
        marker,
        currentMarker: params.currentMarker,
        activeAndFocused: params.activeAndFocused,
        lastSucceededMarker: () => markReadState.lastSucceededMarker,
        retry: params.retry,
      });
    }
  }
}
