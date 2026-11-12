'use client';

import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
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

type PrependScrollPosition = {
  scrollTop: number;
  scrollHeight: number;
  anchor: { element: Element; top: number; partId?: string } | null;
};

export function capturePrependScrollPosition(el: HTMLElement): PrependScrollPosition {
  const viewport = el.getBoundingClientRect();
  let anchor: PrependScrollPosition['anchor'] = null;
  // A page can regroup assistant messages. Part ids survive that row replacement.
  for (const selector of ['[data-scroll-anchor]', '[data-message-id]']) {
    for (const marker of el.querySelectorAll<HTMLElement>(selector)) {
      const partId = marker.dataset.scrollAnchor;
      const element = partId ? marker.nextElementSibling : marker;
      if (!element || element.hasAttribute('hidden')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        anchor = { element, top: rect.top - viewport.top, ...(partId ? { partId } : {}) };
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
  if (anchor?.partId && element && !el.contains(element)) {
    const marker = [...el.querySelectorAll<HTMLElement>('[data-scroll-anchor]')].find(
      marker => marker.dataset.scrollAnchor === anchor.partId
    );
    const replacement = marker?.nextElementSibling;
    element = replacement ?? undefined;
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

  useLayoutEffect(() => {
    inFlightRef.current = false;
    pendingPositionRef.current = null;
    wasLoadingRef.current = false;
    return () => cancelAnimationFrame(restoreFrameRef.current);
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

  useLayoutEffect(() => {
    if (!ready) return;
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoadingOlderMessages;
    if (!wasLoading || isLoadingOlderMessages) return;
    const previousPosition = pendingPositionRef.current;
    if (previousPosition == null) return;
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
      if (
        canAutoloadOlderMessages(el) &&
        autoloadOnMount &&
        el.scrollTop < OLDER_MESSAGES_NEAR_TOP_PX &&
        olderMessagesError === null
      ) {
        requestOlderMessages();
      }
    });
  }, [
    isLoadingOlderMessages,
    isProgrammaticScrollRef,
    lastScrollTopRef,
    olderMessagesError,
    ready,
    requestOlderMessages,
    scrollElementRef,
    autoloadOnMount,
  ]);

  useLayoutEffect(() => {
    if (!ready || !autoloadOnMount) return;
    if (olderMessagesError) return;
    const el = scrollElementRef.current;
    if (!el) return;
    if (!canAutoloadOlderMessages(el)) return;
    if (el.scrollHeight <= el.clientHeight) {
      requestOlderMessages();
    }
  }, [
    autoloadOnMount,
    olderMessagesError,
    overflowCheckKey,
    ready,
    requestOlderMessages,
    scrollElementRef,
  ]);

  const tryLoadOlderFromScroll = useCallback(
    (scrollTop: number) => {
      if (isProgrammaticScrollRef.current || initialPositionedRef?.current === false) return;
      const el = scrollElementRef.current;
      if (el && pendingPositionRef.current) {
        pendingPositionRef.current = capturePrependScrollPosition(el);
      }
      if (scrollTop < OLDER_MESSAGES_NEAR_TOP_PX) {
        requestOlderMessages();
      }
    },
    [requestOlderMessages, initialPositionedRef, isProgrammaticScrollRef, scrollElementRef]
  );

  return { requestOlderMessages, tryLoadOlderFromScroll };
}
