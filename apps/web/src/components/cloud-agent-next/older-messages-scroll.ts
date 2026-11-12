'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { type OlderMessagesError } from '@kilocode/cloud-agent-sdk';

export const OLDER_MESSAGES_NEAR_TOP_PX = 80;
export const OLDER_MESSAGES_NEAR_BOTTOM_PX = 100;

type ShouldTriggerOlderMessagesLoadInputs = {
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  isInFlight: boolean;
  olderMessagesError: OlderMessagesError | null;
};

export function shouldTriggerOlderMessagesLoad({
  hasOlderMessages,
  isLoadingOlderMessages,
  isInFlight,
  olderMessagesError,
}: ShouldTriggerOlderMessagesLoadInputs): boolean {
  if (!hasOlderMessages) {
    return false;
  }
  if (isLoadingOlderMessages) {
    return false;
  }
  if (isInFlight) {
    return false;
  }
  if (olderMessagesError && olderMessagesError.kind !== 'retryable') {
    return false;
  }
  return true;
}

type ScrollAnchorKey = 'data-scroll-anchor' | 'data-message-id';

type PrependScrollPosition = {
  scrollTop: number;
  scrollHeight: number;
  anchor: { element: Element; top: number; key: ScrollAnchorKey; value: string } | null;
};

function getPartScrollAnchorElement(marker: Element): Element | undefined {
  return marker.closest('[data-scroll-anchor-group]') ?? marker.nextElementSibling ?? undefined;
}

export function capturePrependScrollPosition(el: HTMLElement): PrependScrollPosition {
  const viewport = el.getBoundingClientRect();
  let anchor: PrependScrollPosition['anchor'] = null;
  // A page can regroup assistant messages. Part ids survive that row replacement.
  for (const key of ['data-scroll-anchor', 'data-message-id'] as const) {
    for (const marker of el.querySelectorAll<HTMLElement>(`[${key}]`)) {
      const value = marker.getAttribute(key);
      if (!value) continue;
      const element = key === 'data-scroll-anchor' ? getPartScrollAnchorElement(marker) : marker;
      if (!element || element.hasAttribute('hidden')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        anchor = { element, top: rect.top - viewport.top, key, value };
        break;
      }
    }
    if (anchor) break;
  }
  return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, anchor };
}

export function restoreScrollAfterPrepend(el: HTMLElement, previous: PrependScrollPosition): void {
  const anchor = previous.anchor;
  let element = anchor?.element;
  if (anchor && element && !el.contains(element)) {
    const marker = [...el.querySelectorAll<HTMLElement>(`[${anchor.key}]`)].find(
      marker => marker.getAttribute(anchor.key) === anchor.value
    );
    // Regrouping can retain the old message id on a zero-height span inside the new row.
    element =
      anchor.key === 'data-scroll-anchor'
        ? marker
          ? getPartScrollAnchorElement(marker)
          : undefined
        : (marker?.closest('[data-message-role]') ?? marker);
  }
  if (anchor && element && el.contains(element)) {
    const top = element.getBoundingClientRect().top - el.getBoundingClientRect().top;
    // Measure only movement above the reader, including any browser scroll anchoring.
    el.scrollTop += top - anchor.top;
    return;
  }
  el.scrollTop = previous.scrollTop + el.scrollHeight - previous.scrollHeight;
}

export function canAutoloadOlderMessages(
  el: Pick<HTMLElement, 'hidden' | 'clientHeight'>
): boolean {
  return !el.hidden && el.clientHeight > 0;
}

export type OlderMessagesHeaderState =
  | { kind: 'hidden' }
  | { kind: 'retryable' }
  | { kind: 'invalid_data' }
  | { kind: 'too_large' }
  | { kind: 'omitted'; count: number };

export function selectOlderMessagesHeaderState({
  isLoadingOlderMessages,
  olderMessagesError,
  olderMessagesOmittedItemCount,
}: {
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  olderMessagesOmittedItemCount: number;
}): OlderMessagesHeaderState {
  if (olderMessagesError) {
    if (olderMessagesError.kind === 'retryable') {
      return { kind: 'retryable' };
    }
    if (olderMessagesError.kind === 'invalid_data') {
      return { kind: 'invalid_data' };
    }
    return { kind: 'too_large' };
  }
  if (isLoadingOlderMessages) {
    if (olderMessagesOmittedItemCount > 0) {
      return { kind: 'omitted', count: olderMessagesOmittedItemCount };
    }
    return { kind: 'hidden' };
  }
  if (olderMessagesOmittedItemCount > 0) {
    return { kind: 'omitted', count: olderMessagesOmittedItemCount };
  }
  return { kind: 'hidden' };
}

type ShouldAnnounceOlderMessagesArrivalInputs = {
  wasInitialized: boolean;
  previousCount: number;
  nextCount: number;
  previousNewestKey: string | null;
  nextNewestKey: string | null;
};

export function shouldAnnounceOlderMessagesArrival({
  wasInitialized,
  previousCount,
  nextCount,
  previousNewestKey,
  nextNewestKey,
}: ShouldAnnounceOlderMessagesArrivalInputs): boolean {
  if (!wasInitialized) {
    return false;
  }
  if (nextCount <= previousCount) {
    return false;
  }
  if (previousNewestKey == null || nextNewestKey == null) {
    return false;
  }
  return previousNewestKey === nextNewestKey;
}

type UseOlderMessagesPaginationInputs = {
  scrollElementRef: RefObject<HTMLElement | null>;
  scrollContentRef?: RefObject<HTMLElement | null>;
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  onLoad: () => void | Promise<void>;
  isProgrammaticScrollRef: RefObject<boolean>;
  lastScrollTopRef: RefObject<number>;
  resetKey: string | null | undefined;
  overflowCheckKey?: unknown;
  ready: boolean;
  autoloadOnMount?: boolean;
  initialPositionedRef?: RefObject<boolean>;
};

export function useOlderMessagesPagination({
  scrollElementRef,
  scrollContentRef,
  hasOlderMessages,
  isLoadingOlderMessages,
  olderMessagesError,
  onLoad,
  isProgrammaticScrollRef,
  lastScrollTopRef,
  resetKey,
  overflowCheckKey,
  ready,
  autoloadOnMount = true,
  initialPositionedRef,
}: UseOlderMessagesPaginationInputs): {
  requestOlderMessages: () => void;
  tryLoadOlderFromScroll: (scrollTop: number) => void;
} {
  const inFlightRef = useRef(false);
  const pendingPositionRef = useRef<PrependScrollPosition | null>(null);
  const wasLoadingRef = useRef(isLoadingOlderMessages);
  const restoreFrameRef = useRef(0);
  const captureFrameRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    inFlightRef.current = false;
    pendingPositionRef.current = null;
    wasLoadingRef.current = false;
    return () => {
      cancelAnimationFrame(restoreFrameRef.current);
      if (captureFrameRef.current !== null) cancelAnimationFrame(captureFrameRef.current);
      captureFrameRef.current = null;
    };
  }, [resetKey]);

  const requestOlderMessages = useCallback(() => {
    if (
      !ready ||
      !shouldTriggerOlderMessagesLoad({
        hasOlderMessages,
        isLoadingOlderMessages,
        isInFlight: inFlightRef.current,
        olderMessagesError,
      })
    ) {
      return;
    }
    const el = scrollElementRef.current;
    if (el) pendingPositionRef.current = capturePrependScrollPosition(el);
    inFlightRef.current = true;
    void Promise.resolve(onLoad()).finally(() => {
      queueMicrotask(() => {
        inFlightRef.current = false;
      });
    });
  }, [
    hasOlderMessages,
    isLoadingOlderMessages,
    olderMessagesError,
    onLoad,
    ready,
    scrollElementRef,
  ]);

  const tryAutoloadOlderMessages = useCallback(() => {
    if (!autoloadOnMount) return;
    if (!ready || olderMessagesError || initialPositionedRef?.current === false) return;
    if (isProgrammaticScrollRef.current) return;
    const el = scrollElementRef.current;
    if (el && canAutoloadOlderMessages(el) && el.scrollTop < OLDER_MESSAGES_NEAR_TOP_PX) {
      requestOlderMessages();
    }
  }, [
    autoloadOnMount,
    initialPositionedRef,
    isProgrammaticScrollRef,
    olderMessagesError,
    ready,
    requestOlderMessages,
    scrollElementRef,
  ]);

  useLayoutEffect(() => {
    if (!ready) return;
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoadingOlderMessages;
    if (!wasLoading || isLoadingOlderMessages) return;
    const previousPosition = pendingPositionRef.current;
    if (previousPosition == null) return;
    if (captureFrameRef.current !== null) cancelAnimationFrame(captureFrameRef.current);
    captureFrameRef.current = null;
    const el = scrollElementRef.current;
    pendingPositionRef.current = null;
    if (!el) return;
    if (olderMessagesError != null) return;
    isProgrammaticScrollRef.current = true;
    restoreScrollAfterPrepend(el, previousPosition);
    lastScrollTopRef.current = el.scrollTop;
    restoreFrameRef.current = requestAnimationFrame(() => {
      // The transcript runtime can commit its rows after the loading-state layout effect.
      restoreScrollAfterPrepend(el, previousPosition);
      lastScrollTopRef.current = el.scrollTop;
      isProgrammaticScrollRef.current = false;
      tryAutoloadOlderMessages();
    });
  }, [
    isLoadingOlderMessages,
    isProgrammaticScrollRef,
    lastScrollTopRef,
    olderMessagesError,
    ready,
    requestOlderMessages,
    scrollElementRef,
    tryAutoloadOlderMessages,
  ]);

  useEffect(() => {
    if (!ready || !autoloadOnMount) return;
    if (olderMessagesError) return;
    const el = scrollElementRef.current;
    if (!el) return;
    let frame = 0;
    const scheduleCheck = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tryAutoloadOlderMessages);
    };
    scheduleCheck();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleCheck);
    observer?.observe(el);
    const content = scrollContentRef?.current;
    if (content) observer?.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [
    autoloadOnMount,
    olderMessagesError,
    overflowCheckKey,
    ready,
    resetKey,
    scrollContentRef,
    scrollElementRef,
    tryAutoloadOlderMessages,
  ]);

  const tryLoadOlderFromScroll = useCallback(
    (scrollTop: number) => {
      if (isProgrammaticScrollRef.current || initialPositionedRef?.current === false) return;
      const el = scrollElementRef.current;
      const position = pendingPositionRef.current;
      if (el && position && scrollTop !== position.scrollTop) {
        // Preserve scrolling even if the load completes before the queued capture runs.
        if (position.anchor) position.anchor.top -= scrollTop - position.scrollTop;
        position.scrollTop = scrollTop;
        if (captureFrameRef.current === null) {
          captureFrameRef.current = requestAnimationFrame(() => {
            captureFrameRef.current = null;
            if (pendingPositionRef.current) {
              pendingPositionRef.current = capturePrependScrollPosition(el);
            }
          });
        }
      }
      if (scrollTop < OLDER_MESSAGES_NEAR_TOP_PX) {
        requestOlderMessages();
      }
    },
    [requestOlderMessages, initialPositionedRef, isProgrammaticScrollRef, scrollElementRef]
  );

  return { requestOlderMessages, tryLoadOlderFromScroll };
}
