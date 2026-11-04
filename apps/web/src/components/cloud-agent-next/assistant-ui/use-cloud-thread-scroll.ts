'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type {
  SessionManager,
  PreparationAttempt,
  SessionCommit,
  OlderMessagesError,
} from '@kilocode/cloud-agent-sdk';
import type { StoredMessage } from '../types';
import {
  OLDER_MESSAGES_NEAR_BOTTOM_PX,
  shouldAnnounceOlderMessagesArrival,
  useOlderMessagesPagination,
} from '../older-messages-scroll';
import {
  planResumeAttempt,
  resumeAnchorForTranscript,
  sendTakesOverResume,
} from '../resume-anchor';
const MAX_RESUME_OLDER_PAGES = 8;

type ResumeState = {
  key: string;
  attempts: number;
  done: boolean;
};

/** The rendered element carrying `messageId`, when it is in the DOM. */
function findMessageElement(container: HTMLElement, messageId: string): HTMLElement | null {
  for (const element of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (element.dataset.messageId === messageId) return element;
  }
  return null;
}

/**
 * The scroll target for a resolved anchor: the first of the anchor's candidate
 * ids that is in the DOM. A group can render no element at all — an
 * all-invisible assistant turn draws nothing — and such a group is invisible by
 * design, so the anchor falls to the nearest rendered group after it instead of
 * looking like an unloaded message. Every probed group is already in the loaded
 * window, so a hit never needs an older page.
 */
function findAnchorElement(
  container: HTMLElement,
  selectorIds: readonly string[]
): HTMLElement | null {
  for (const selectorId of selectorIds) {
    const element = findMessageElement(container, selectorId);
    if (element) return element;
  }
  return null;
}

type CloudThreadScrollInput = {
  manager: SessionManager;
  sessionIdFromParams: string | null;
  anchorMessageIdFromParams: string | null;
  chatTabActive: boolean;
  transcriptVisible: boolean;
  transcriptReady: boolean;
  staticMessages: StoredMessage[];
  dynamicMessages: StoredMessage[];
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  isLoading: boolean;
  preparationByMessageId: ReadonlyMap<string, readonly PreparationAttempt[]>;
  commitsAfterMessage: ReadonlyMap<string, readonly SessionCommit[]>;
};
export function useCloudThreadScroll({
  manager,
  sessionIdFromParams,
  anchorMessageIdFromParams,
  chatTabActive,
  transcriptVisible,
  transcriptReady,
  staticMessages,
  dynamicMessages,
  hasOlderMessages,
  isLoadingOlderMessages,
  olderMessagesError,
  isLoading,
  preparationByMessageId,
  commitsAfterMessage,
}: CloudThreadScrollInput) {
  const transcriptMessageCount = staticMessages.length + dynamicMessages.length;
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const chatUI = useAtomValue(manager.atoms.chatUI);
  const setChatUI = useSetAtom(manager.atoms.chatUI);

  // Flag to distinguish programmatic scrolls from user scrolls.
  // Without this, auto-scroll's scrollTo fires handleScroll which re-enables
  // shouldAutoScroll, making it impossible for the user to scroll away during streaming.
  const isAutoScrollingRef = useRef(false);
  const autoScrollRunRef = useRef(0);
  const transcriptPositionedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  // Mirrors `chatUI.shouldAutoScroll` so a scroll already scheduled (rAF or
  // timeout) re-checks the latest intent when it runs, not the value captured
  // when it was scheduled. The resume sets this false synchronously, before the
  // atom update lands, so an in-flight auto-scroll cannot override the anchor.
  const shouldAutoScrollRef = useRef(true);
  const wasNearBottomRef = useRef(true);
  const olderArrivalInitializedRef = useRef(false);
  const olderArrivalCountRef = useRef(0);
  const olderArrivalNewestKeyRef = useRef<string | null>(null);
  const [olderArrivalAnnouncement, setOlderArrivalAnnouncement] = useState('');
  const resumeStateRef = useRef<ResumeState | null>(null);

  const loadOlderMessages = useCallback(() => manager.loadOlderMessages(), [manager]);
  const { requestOlderMessages, tryLoadOlderFromScroll } = useOlderMessagesPagination({
    scrollElementRef: scrollContainerRef,
    hasOlderMessages,
    isLoadingOlderMessages,
    olderMessagesError,
    onLoad: loadOlderMessages,
    isProgrammaticScrollRef: isAutoScrollingRef,
    lastScrollTopRef,
    resetKey: sessionIdFromParams,
    overflowCheckKey: `${chatTabActive}:${staticMessages.length + dynamicMessages.length}`,
    ready: transcriptReady,
  });

  const autoScrollFrameRef = useRef(0);
  const followUpAutoScrollFrameRef = useRef(0);
  const delayedAutoScrollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelScheduledAutoScroll = useCallback(() => {
    cancelAnimationFrame(autoScrollFrameRef.current);
    cancelAnimationFrame(followUpAutoScrollFrameRef.current);
    autoScrollFrameRef.current = 0;
    followUpAutoScrollFrameRef.current = 0;
    if (delayedAutoScrollRef.current !== null) {
      clearTimeout(delayedAutoScrollRef.current);
      delayedAutoScrollRef.current = null;
    }
  }, []);

  const scrollToBottomNow = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el || el.hidden) return;
    if (!shouldAutoScrollRef.current) return;

    setShowScrollButton(false);
    // Already pinned: no scroll event will follow, so do not mark the next
    // frame's scroll as programmatic or a reader's scroll in it is ignored.
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 1) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    const scrollRun = autoScrollRunRef.current + 1;
    autoScrollRunRef.current = scrollRun;
    isAutoScrollingRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;

    requestAnimationFrame(() => {
      if (autoScrollRunRef.current === scrollRun) {
        isAutoScrollingRef.current = false;
      }
    });
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    if (!shouldAutoScrollRef.current) return;

    cancelScheduledAutoScroll();

    autoScrollFrameRef.current = requestAnimationFrame(() => {
      autoScrollFrameRef.current = 0;
      if (!shouldAutoScrollRef.current) return;
      scrollToBottomNow();
      followUpAutoScrollFrameRef.current = requestAnimationFrame(() => {
        followUpAutoScrollFrameRef.current = 0;
        if (shouldAutoScrollRef.current) scrollToBottomNow();
      });
      delayedAutoScrollRef.current = setTimeout(() => {
        delayedAutoScrollRef.current = null;
        if (shouldAutoScrollRef.current) scrollToBottomNow();
      }, 100);
    });
  }, [cancelScheduledAutoScroll, scrollToBottomNow]);

  useEffect(() => cancelScheduledAutoScroll, [cancelScheduledAutoScroll]);

  useLayoutEffect(() => {
    // An in-progress resume has already paused auto-scroll and owns the
    // position; do not let an atom write (e.g. a session reset) re-enable it.
    const resumeState = resumeStateRef.current;
    if (resumeState && !resumeState.done) return;
    shouldAutoScrollRef.current = chatUI.shouldAutoScroll;
  }, [chatUI.shouldAutoScroll]);

  useLayoutEffect(() => {
    cancelScheduledAutoScroll();
    autoScrollRunRef.current += 1;
    isAutoScrollingRef.current = false;
    transcriptPositionedRef.current = false;
    resumeStateRef.current =
      sessionIdFromParams && anchorMessageIdFromParams
        ? {
            key: `${sessionIdFromParams}\u0000${anchorMessageIdFromParams}`,
            attempts: 0,
            done: false,
          }
        : null;
    shouldAutoScrollRef.current = !resumeStateRef.current;
    setChatUI({ shouldAutoScroll: shouldAutoScrollRef.current });
    lastScrollTopRef.current = 0;
    wasNearBottomRef.current = true;
    olderArrivalInitializedRef.current = false;
    olderArrivalCountRef.current = 0;
    olderArrivalNewestKeyRef.current = null;
    setOlderArrivalAnnouncement('');
    setShowScrollButton(false);
  }, [anchorMessageIdFromParams, cancelScheduledAutoScroll, sessionIdFromParams, setChatUI]);

  useLayoutEffect(() => {
    if (!chatTabActive || !transcriptVisible) {
      cancelScheduledAutoScroll();
      transcriptPositionedRef.current = false;
    }
  }, [cancelScheduledAutoScroll, chatTabActive, transcriptVisible]);

  useLayoutEffect(() => {
    if (!transcriptVisible || !chatTabActive || transcriptMessageCount === 0) return;
    if (transcriptPositionedRef.current) return;
    transcriptPositionedRef.current = true;
    scrollToBottomNow();
  }, [
    anchorMessageIdFromParams,
    chatTabActive,
    scrollToBottomNow,
    sessionIdFromParams,
    transcriptMessageCount,
    transcriptVisible,
  ]);

  useLayoutEffect(() => {
    if (!transcriptVisible || !chatTabActive || !chatUI.shouldAutoScroll) return;
    scrollToBottomNow();
  }, [
    staticMessages,
    dynamicMessages,
    chatTabActive,
    chatUI.shouldAutoScroll,
    scrollToBottomNow,
    transcriptVisible,
  ]);

  useEffect(() => {
    if (!transcriptVisible || !chatTabActive || !chatUI.shouldAutoScroll) return;
    if (typeof ResizeObserver === 'undefined') return;

    const content = messagesContentRef.current;
    if (!content) return;

    // Resize callbacks run after layout and before paint, so pinning here keeps
    // growth that bypasses the message effect (status rows, late layout) from
    // showing for a frame; the scheduled pass still catches later layout.
    const observer = new ResizeObserver(() => {
      scrollToBottomNow();
      scheduleScrollToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [
    chatTabActive,
    chatUI.shouldAutoScroll,
    scheduleScrollToBottom,
    scrollToBottomNow,
    transcriptVisible,
  ]);

  const newestTranscriptMessageId =
    dynamicMessages.at(-1)?.info.id ?? staticMessages.at(-1)?.info.id ?? null;

  useEffect(() => {
    if (!transcriptReady) return;
    if (
      shouldAnnounceOlderMessagesArrival({
        wasInitialized: olderArrivalInitializedRef.current,
        previousCount: olderArrivalCountRef.current,
        nextCount: transcriptMessageCount,
        previousNewestKey: olderArrivalNewestKeyRef.current,
        nextNewestKey: newestTranscriptMessageId,
      })
    ) {
      setOlderArrivalAnnouncement('Earlier messages loaded');
    }
    olderArrivalInitializedRef.current = true;
    olderArrivalCountRef.current = transcriptMessageCount;
    olderArrivalNewestKeyRef.current = newestTranscriptMessageId;
  }, [newestTranscriptMessageId, transcriptMessageCount, transcriptReady]);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (!transcriptVisible) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollButton(distanceFromBottom > 20);

    if (isAutoScrollingRef.current) {
      lastScrollTopRef.current = el.scrollTop;
      return;
    }

    // A real user scroll takes over from a resume that is still looking for its
    // anchor, so the transcript stops moving under the user.
    const resumeState = resumeStateRef.current;
    if (resumeState && !resumeState.done) {
      resumeState.done = true;
    }

    const scrolledUp = el.scrollTop < lastScrollTopRef.current;
    lastScrollTopRef.current = el.scrollTop;

    if (scrolledUp || distanceFromBottom >= OLDER_MESSAGES_NEAR_BOTTOM_PX) {
      shouldAutoScrollRef.current = false;
      setChatUI({ shouldAutoScroll: false });
      cancelScheduledAutoScroll();
    } else if (distanceFromBottom < OLDER_MESSAGES_NEAR_BOTTOM_PX) {
      shouldAutoScrollRef.current = true;
      setChatUI({ shouldAutoScroll: true });
    }

    tryLoadOlderFromScroll(el.scrollTop);

    const isNearBottom = distanceFromBottom < OLDER_MESSAGES_NEAR_BOTTOM_PX;
    if (isNearBottom && !wasNearBottomRef.current) {
      manager.trimRetainedHistory();
    }
    wasNearBottomRef.current = isNearBottom;
  }, [cancelScheduledAutoScroll, manager, setChatUI, transcriptVisible, tryLoadOlderFromScroll]);

  const scrollToBottom = useCallback(() => {
    shouldAutoScrollRef.current = true;
    setChatUI({ shouldAutoScroll: true });
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom, setChatUI]);

  // One shot per (session, anchor): land the anchor message at the top of the
  // transcript, loading older pages while it still sits before the loaded
  // window. A real user scroll or a send ends the attempt, and so does an
  // anchor the run cannot reach: an id absent from the loaded window after 8
  // pages, no older history to search, a failed older page, or a group that
  // renders no element. Each ends it by opening exactly as an anchor-less link
  // does: at the bottom, following new output. The transcript container starts
  // at `scrollTop = 0`, so leaving the paused resume behind would strand the
  // reader on the oldest loaded message with follow off.
  useLayoutEffect(() => {
    if (!transcriptVisible) return;
    if (!chatTabActive || !sessionIdFromParams || !anchorMessageIdFromParams) return;
    if (isLoading) return;

    const key = `${sessionIdFromParams}\u0000${anchorMessageIdFromParams}`;
    const previous = resumeStateRef.current;
    const state: ResumeState =
      previous && previous.key === key ? previous : { key, attempts: 0, done: false };
    resumeStateRef.current = state;
    if (state.done) return;

    // The resume owns the scroll for this view: pause auto-scroll now, and
    // cancel anything already scheduled, so neither an in-flight frame nor the
    // auto-scroll effect can snap the transcript to the bottom while older
    // pages load toward the anchor.
    shouldAutoScrollRef.current = false;
    setChatUI({ shouldAutoScroll: false });
    cancelScheduledAutoScroll();

    // The snapshot for this session has not painted yet; wait for its commit.
    if (staticMessages.length === 0 && dynamicMessages.length === 0 && !hasOlderMessages) return;

    // Group exactly as the transcript renders (same preparation rows and commit
    // anchors), or the anchor resolves against boundaries the renderer does not
    // have and lands on an earlier rendered group.
    const anchor = resumeAnchorForTranscript(
      [...staticMessages, ...dynamicMessages],
      preparationByMessageId,
      commitsAfterMessage,
      anchorMessageIdFromParams
    );
    const container = scrollContainerRef.current;
    const element = anchor && container ? findAnchorElement(container, anchor.selectorIds) : null;
    if (!element && !transcriptReady) return;

    const step = planResumeAttempt({
      anchorRendered: element !== null && container !== null,
      anchorResolved: anchor !== null,
      attempts: state.attempts,
      maxOlderPages: MAX_RESUME_OLDER_PAGES,
      hasOlderMessages,
      isLoadingOlderMessages,
      hasOlderMessagesError: olderMessagesError !== null,
    });

    if (step === 'scroll' && element && container) {
      state.done = true;
      isAutoScrollingRef.current = true;
      container.scrollTop = element.offsetTop;
      lastScrollTopRef.current = container.scrollTop;
      const scrollRun = autoScrollRunRef.current + 1;
      autoScrollRunRef.current = scrollRun;
      requestAnimationFrame(() => {
        if (autoScrollRunRef.current === scrollRun) {
          isAutoScrollingRef.current = false;
        }
      });
      return;
    }

    if (step === 'follow-tail') {
      // The anchor cannot be reached — a deleted or trimmed message, an id past
      // the page bound, an older page that failed to load, or a group that
      // renders no element — so no later attempt can reach it. Give up the way
      // an anchor-less link opens: follow the tail again, so the reader lands
      // at the bottom instead of staying paused on the oldest loaded message
      // with follow off (the mobile `?at=` contract).
      shouldAutoScrollRef.current = true;
      setChatUI({ shouldAutoScroll: true });
      scheduleScrollToBottom();
      state.done = true;
      return;
    }

    if (step === 'load-older') {
      state.attempts += 1;
      requestOlderMessages();
    }
  }, [
    anchorMessageIdFromParams,
    cancelScheduledAutoScroll,
    chatTabActive,
    commitsAfterMessage,
    dynamicMessages,
    hasOlderMessages,
    isLoading,
    isLoadingOlderMessages,
    olderMessagesError,
    preparationByMessageId,
    requestOlderMessages,
    scheduleScrollToBottom,
    sessionIdFromParams,
    setChatUI,
    staticMessages,
    transcriptReady,
    transcriptVisible,
  ]);

  const captureSendPosition = useCallback(() => resumeStateRef.current, []);
  const followAcceptedSend = useCallback(
    (previous: ResumeState | null) => {
      if (!sendTakesOverResume(previous, resumeStateRef.current)) return;
      if (previous) previous.done = true;
      shouldAutoScrollRef.current = true;
      setChatUI({ shouldAutoScroll: true });
      scheduleScrollToBottom();
    },
    [setChatUI, scheduleScrollToBottom]
  );
  return {
    scrollContainerRef,
    messagesContentRef,
    messagesEndRef,
    showScrollButton,
    olderArrivalAnnouncement,
    requestOlderMessages,
    handleScroll,
    scrollToBottom,
    scheduleScrollToBottom,
    captureSendPosition,
    followAcceptedSend,
  };
}
