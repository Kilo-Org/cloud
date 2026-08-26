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

export function restoreScrollAfterPrepend(
  el: { scrollTop: number; scrollHeight: number },
  previousScrollHeight: number
): void {
  el.scrollTop += el.scrollHeight - previousScrollHeight;
}

export function canAutoloadOlderMessages(el: Pick<HTMLElement, 'hidden' | 'clientHeight'>): boolean {
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
}: UseOlderMessagesPaginationInputs): {
  requestOlderMessages: () => void;
  tryLoadOlderFromScroll: (scrollTop: number) => void;
} {
  const inFlightRef = useRef(false);
  const pendingHeightRef = useRef<number | null>(null);
  const wasLoadingRef = useRef(isLoadingOlderMessages);

  useEffect(() => {
    inFlightRef.current = false;
    pendingHeightRef.current = null;
    wasLoadingRef.current = false;
  }, [resetKey]);

  const requestOlderMessages = useCallback(() => {
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
    const el = scrollElementRef.current;
    if (el) pendingHeightRef.current = el.scrollHeight;
    inFlightRef.current = true;
    void Promise.resolve(onLoad()).finally(() => {
      queueMicrotask(() => {
        inFlightRef.current = false;
      });
    });
  }, [hasOlderMessages, isLoadingOlderMessages, olderMessagesError, onLoad, scrollElementRef]);

  useLayoutEffect(() => {
    const wasLoading = wasLoadingRef.current;
    wasLoadingRef.current = isLoadingOlderMessages;
    if (!wasLoading || isLoadingOlderMessages) return;
    const previousHeight = pendingHeightRef.current;
    if (previousHeight == null) return;
    const el = scrollElementRef.current;
    pendingHeightRef.current = null;
    if (!el) return;
    if (olderMessagesError != null) return;
    isProgrammaticScrollRef.current = true;
    restoreScrollAfterPrepend(el, previousHeight);
    lastScrollTopRef.current = el.scrollTop;
    requestAnimationFrame(() => {
      isProgrammaticScrollRef.current = false;
      if (
        canAutoloadOlderMessages(el) &&
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
    requestOlderMessages,
    scrollElementRef,
  ]);

  useLayoutEffect(() => {
    if (olderMessagesError) return;
    const el = scrollElementRef.current;
    if (!el) return;
    if (!canAutoloadOlderMessages(el)) return;
    if (el.scrollHeight <= el.clientHeight) {
      requestOlderMessages();
    }
  }, [olderMessagesError, overflowCheckKey, requestOlderMessages, scrollElementRef]);

  const tryLoadOlderFromScroll = useCallback(
    (scrollTop: number) => {
      if (scrollTop < OLDER_MESSAGES_NEAR_TOP_PX) {
        requestOlderMessages();
      }
    },
    [requestOlderMessages]
  );

  return { requestOlderMessages, tryLoadOlderFromScroll };
}
