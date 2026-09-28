import { useEffect, useRef } from 'react';
import { type ViewabilityConfig } from 'react-native';
import { type ViewToken } from '@shopify/flash-list';

import {
  getSessionTranscriptItemMessageId,
  type SessionTranscriptItem,
} from '@/components/agents/session-transcript';

// The reported position is a fact about the viewport, not about each scroll
// frame: a report re-renders the host and writes a route param, so the report
// is coalesced to at most one per second, and only when the topmost visible
// message actually changed.
const ANCHOR_REPORT_MIN_INTERVAL_MS = 1000;

// A row claims the viewport only once half of it is on screen, so a row peeking
// in during a fling cannot become the reported position.
const ANCHOR_VIEWABILITY_CONFIG: ViewabilityConfig = { itemVisiblePercentThreshold: 50 };

/**
 * The topmost viewable row that names a message. A preparation row has no
 * message id of its own, so it is skipped instead of blanking the anchor.
 */
function firstViewableAnchorMessageId<T>(viewableItems: readonly ViewToken<T>[]): string | null {
  let bestIndex = Number.POSITIVE_INFINITY;
  let bestId: string | null = null;
  for (const token of viewableItems.filter(entry => entry.isViewable)) {
    // Only the session screen passes `onAnchorChange`, always with transcript
    // items; the assertion is confined to that path.
    const id = getSessionTranscriptItemMessageId(token.item as SessionTranscriptItem);
    const index = token.index ?? Number.POSITIVE_INFINITY;
    if (id !== null && index < bestIndex) {
      bestIndex = index;
      bestId = id;
    }
  }
  return bestId;
}

type SessionListAnchorReport<T> = {
  onViewableItemsChanged: ((info: { viewableItems: ViewToken<T>[] }) => void) | undefined;
  viewabilityConfig: ViewabilityConfig | undefined;
};

/**
 * Viewport-position reporting for `SessionMessageList`. The refs keep
 * FlashList's viewability callback stable and keep the report off the render
 * path. Absent `onAnchorChange`, nothing is wired, so every caller that does
 * not publish a position stays byte-identical.
 */
export function useSessionListAnchorReport<T>({
  sessionId,
  onAnchorChange,
}: {
  readonly sessionId: string;
  readonly onAnchorChange?: (messageId: string) => void;
}): SessionListAnchorReport<T> {
  const onAnchorChangeRef = useRef(onAnchorChange);
  onAnchorChangeRef.current = onAnchorChange;
  const lastAnchorIdRef = useRef<string | null>(null);
  const lastAnchorReportAtRef = useRef(0);
  const pendingAnchorIdRef = useRef<string | null>(null);
  const anchorReportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushAnchorReport = useRef(() => {
    anchorReportTimerRef.current = null;
    const nextId = pendingAnchorIdRef.current;
    if (nextId === null || nextId === lastAnchorIdRef.current) {
      return;
    }
    lastAnchorIdRef.current = nextId;
    lastAnchorReportAtRef.current = Date.now();
    onAnchorChangeRef.current?.(nextId);
  }).current;
  const handleViewableItemsChanged = useRef((info: { viewableItems: ViewToken<T>[] }) => {
    const nextId = firstViewableAnchorMessageId(info.viewableItems);
    if (nextId === null) {
      return;
    }
    // Record the latest position before the change check. A settle back onto
    // the already-reported row must supersede the intermediate id a scheduled
    // report still holds, otherwise the trailing flush would publish a row the
    // user has scrolled away from.
    pendingAnchorIdRef.current = nextId;
    if (nextId === lastAnchorIdRef.current) {
      return;
    }
    if (anchorReportTimerRef.current !== null) {
      // A report is already scheduled: the trailing report publishes the latest
      // position, so this intermediate one is dropped rather than queued.
      return;
    }
    const elapsed = Date.now() - lastAnchorReportAtRef.current;
    if (elapsed >= ANCHOR_REPORT_MIN_INTERVAL_MS) {
      flushAnchorReport();
      return;
    }
    anchorReportTimerRef.current = setTimeout(
      flushAnchorReport,
      ANCHOR_REPORT_MIN_INTERVAL_MS - elapsed
    );
  }).current;

  // A new session must not inherit the previous one's report state, and a
  // trailing report must not outlive the list.
  useEffect(() => {
    lastAnchorIdRef.current = null;
    lastAnchorReportAtRef.current = 0;
    pendingAnchorIdRef.current = null;
    if (anchorReportTimerRef.current !== null) {
      clearTimeout(anchorReportTimerRef.current);
      anchorReportTimerRef.current = null;
    }
  }, [sessionId]);
  useEffect(
    () => () => {
      if (anchorReportTimerRef.current !== null) {
        clearTimeout(anchorReportTimerRef.current);
        anchorReportTimerRef.current = null;
      }
    },
    []
  );

  if (onAnchorChange === undefined) {
    return { onViewableItemsChanged: undefined, viewabilityConfig: undefined };
  }
  return {
    onViewableItemsChanged: handleViewableItemsChanged,
    viewabilityConfig: ANCHOR_VIEWABILITY_CONFIG,
  };
}
