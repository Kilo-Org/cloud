export const MARK_READ_RETRY_LIMIT = 3;
export const MARK_READ_RETRY_DELAY_MS = 250;

export type MarkReadRetryState = {
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
    isVisible: () => boolean;
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
      !params.isVisible() ||
      params.lastSucceededMarker() === params.marker
    ) {
      return;
    }
    params.retry();
  }, delayMs);
}
