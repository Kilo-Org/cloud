import { useEffect, useState } from 'react';

/**
 * How long an open may show only the skeleton before the UI admits the load is
 * slow. Long enough that an ordinary cold open never flashes the slow state,
 * short enough that a stalled transport stops looking like progress.
 */
export const SESSION_SLOW_LOAD_MS = 30_000;

/**
 * What the session-open surface should show:
 *
 * - `content` — the transcript (or a settled empty state) is on screen.
 * - `failed`  — a terminal error owns the screen; never relabelled as slow.
 * - `loading` — the skeleton, before the slow threshold (or while a visible
 *   progress indicator proves the load is still moving).
 * - `slow`    — the skeleton has outlived the threshold with nothing to show
 *   and no progress to watch, so it is replaced by a message plus Retry.
 */
export type SessionLoadPhase = 'content' | 'failed' | 'loading' | 'slow';

export type SessionLoadPhaseInput = {
  isLoading: boolean;
  hasContent: boolean;
  hasError: boolean;
  /** A status indicator (progress/info) is on screen, so the load is not stalled. */
  hasStatusIndicator: boolean;
  /** Milliseconds the loading state has been on screen. */
  elapsedMs: number;
};

/**
 * Pure phase resolver. Failure wins over everything, content wins over
 * loading, and a live progress indicator is never called slow.
 */
export function resolveSessionLoadPhase({
  isLoading,
  hasContent,
  hasError,
  hasStatusIndicator,
  elapsedMs,
}: SessionLoadPhaseInput): SessionLoadPhase {
  if (hasError) {
    return 'failed';
  }
  if (hasContent) {
    return 'content';
  }
  if (!isLoading) {
    return 'content';
  }
  if (hasStatusIndicator) {
    return 'loading';
  }
  return elapsedMs >= SESSION_SLOW_LOAD_MS ? 'slow' : 'loading';
}

export type SessionSlowLoadPhaseInput = Pick<
  SessionLoadPhaseInput,
  'isLoading' | 'hasContent' | 'hasError' | 'hasStatusIndicator'
> & {
  /**
   * Epoch ms when this open began (the route's mount). The threshold is
   * measured from here, so a slow metadata round trip ahead of the
   * transcript screen eats into the skeleton's grace instead of restarting
   * the clock. Omitted (or future) means the full threshold from the moment
   * this surface starts watching.
   */
  openStartedAt?: number;
};

/**
 * Resolves the load phase for the current render, arming a single timer when a
 * stalled open begins (loading, no content, no error, no progress indicator)
 * and clearing it when content, an error, a progress indicator or unmount ends
 * the wait. With `openStartedAt`, the timer runs for the time remaining from
 * the open's start, not a fresh threshold. The timer only ever flags that the
 * threshold elapsed; the pure resolver still owns the final phase.
 */
export function useSessionSlowLoadPhase({
  isLoading,
  hasContent,
  hasError,
  hasStatusIndicator,
  openStartedAt,
}: SessionSlowLoadPhaseInput): SessionLoadPhase {
  const isStalled = isLoading && !hasContent && !hasError && !hasStatusIndicator;
  const [hasReachedThreshold, setHasReachedThreshold] = useState(false);

  useEffect(() => {
    if (!isStalled) {
      setHasReachedThreshold(false);
      return undefined;
    }
    const elapsedMs = openStartedAt === undefined ? 0 : Date.now() - openStartedAt;
    const timer = setTimeout(
      () => {
        setHasReachedThreshold(true);
      },
      Math.max(0, SESSION_SLOW_LOAD_MS - elapsedMs)
    );
    return () => {
      clearTimeout(timer);
    };
  }, [isStalled, openStartedAt]);

  return resolveSessionLoadPhase({
    isLoading,
    hasContent,
    hasError,
    hasStatusIndicator,
    elapsedMs: hasReachedThreshold ? SESSION_SLOW_LOAD_MS : 0,
  });
}
