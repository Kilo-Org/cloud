import { type FlashListRef } from '@shopify/flash-list';
import { type OlderMessagesError } from '@kilocode/cloud-agent-sdk';
import { type RefObject, useCallback, useEffect, useRef } from 'react';

import { shouldTriggerOlderMessagesLoad } from '@/components/agents/session-message-list-state';
import { planResumeScroll } from '@/lib/session-resume';

/**
 * Re-scroll schedule for a `?at=` resume. A mount-time resume scroll loses
 * the cold-open race: FlashList's own bottom-start initial scroll re-fires
 * on every layout commit until its completion timer runs, and under the JS
 * load of measuring a page of tall rows those re-fires (plus their queued
 * re-scrolls) drain for well over a second — every earlier scroll is
 * re-asserted back to the newest message (device: the bottom re-assertion
 * overrode retries at 250ms and 650ms, and an anchor at message 30 settled
 * on message 34 with message 30 still painted over it under the previous
 * `initialScrollIndex` approach). The warm scroll — rows already measured —
 * lands exactly, so the retries simply re-run the same scroll until the
 * initial-scroll machinery has drained; every retry re-targets the anchor
 * from the rows the list holds at that moment, and each is a no-op once the
 * scroll has landed.
 */
const RESUME_RETRY_DELAYS_MS = [250, 650, 1200, 2000] as const;

/**
 * How long each resume suppression keeps the tail follow disarmed: the gap
 * to the next retry plus the scroll's own event settle. The FINAL retry
 * suppresses nothing: by then FlashList's bottom-start re-assertions have
 * drained, so its scroll events flow and re-establish the at-bottom state
 * (and the scroll-to-bottom affordance) honestly.
 */
const RESUME_RETRY_SUPPRESS_MS = 600;

/**
 * The cold-open arming window, armed at mount. FlashList's bottom-start
 * initial scroll fires its native `onScroll` events asynchronously — after
 * the whole commit effect has run — and under a page of tall rows the list
 * sits "at the bottom" for the entire measurement settle. If the tail follow
 * sees any of those events it arms itself, and every later content-size
 * change (rows finishing their markdown measurement) then calls
 * `scrollToLatestMessage` directly — that path deliberately bypasses the
 * programmatic-scroll guard for streaming, so no retry can out-race it
 * (device: with suppression only on the retries, every cold open settled on
 * the tail, 59/60, while the retries fired and landed in between).
 * Suppressing from the mount commit means the follow is never armed by the
 * bottom start: it stays at its `followTailAtMount=false` value, the
 * content-size follow stays off, and the retries land and hold. The window
 * bridges to the first retry, which re-arms it.
 */
const RESUME_MOUNT_SUPPRESS_MS = RESUME_RETRY_DELAYS_MS[0] + RESUME_RETRY_SUPPRESS_MS;

type UseSessionListResumeScrollParams<ItemT> = {
  sessionId: string;
  anchorIds: readonly (string | null)[];
  hasOlderMessages: boolean;
  isLoadingOlderMessages: boolean;
  olderMessagesError: OlderMessagesError | null;
  onLoadOlderMessages: () => void;
  /** The component's coalescing guard for `onLoadOlderMessages` re-fires. */
  isInFlightRef: RefObject<boolean>;
  listRef: RefObject<FlashListRef<ItemT> | null>;
  isUserScrollingRef: RefObject<boolean>;
  /** Sticky per-session "the user has grabbed the list" flag from the auto-scroll hook. */
  userInteractedRef: RefObject<boolean>;
  /**
   * True while a send's take-over is the current claim on the position. A send
   * ends a resume that is still paging for its anchor: the position now belongs
   * to the send's output, so the resume must not keep pulling older pages under
   * it.
   */
  sendTakeoverRef: RefObject<boolean>;
  suppressAutoFollow: (ms: number) => void;
  /**
   * Message id a `?at=` deep link wants the transcript to open on. When it is
   * a rendered row the list scrolls to it; when it lives in an older page the
   * list loads pages up to a bound and re-plans. Absent/null keeps every
   * existing caller byte-identical, and an anchor the session no longer has
   * scrolls nothing and blanks nothing.
   */
  resumeAt?: string | null;
};

/**
 * Resume-position scroll for a `?at=` deep link. Runs once per
 * (sessionId, resumeAt) pair: an anchor among the rendered rows scrolls to
 * its index (through bounded retries — see `RESUME_RETRY_DELAYS_MS`); an
 * anchor still in an older page requests one page (bounded by
 * `planResumeScroll`) and re-plans on the next render. An anchor the session
 * no longer has plans 'none' — nothing scrolls and nothing blanks, so the
 * session opens exactly as it does without an anchor.
 *
 * The budget counts page REQUESTS, not effect re-runs: streaming updates
 * change `items` (and with it `anchorIds`) many times while one page is in
 * flight, and counting those re-runs would spend the whole budget in a burst,
 * mark the resume done, and drop the anchor's page when it arrives. The same
 * guard `onStartReached` uses makes a re-run while a load is in flight a
 * no-op; the plan runs again when the page lands.
 *
 * A send ends the plan wherever it is: the warm scroll and the retries drop on
 * the sticky take-over flag, and the load-older branch ends the resume on the
 * send's own flag (`sendTakeoverRef`) instead of pulling another page under the
 * output the send owns.
 */
export function useSessionListResumeScroll<ItemT>({
  sessionId,
  anchorIds,
  hasOlderMessages,
  isLoadingOlderMessages,
  olderMessagesError,
  onLoadOlderMessages,
  isInFlightRef,
  listRef,
  isUserScrollingRef,
  userInteractedRef,
  sendTakeoverRef,
  suppressAutoFollow,
  resumeAt,
}: UseSessionListResumeScrollParams<ItemT>): void {
  const resumeAnchor =
    resumeAt !== undefined && resumeAt !== null && resumeAt.trim().length > 0
      ? resumeAt.trim()
      : null;

  const resumeStateRef = useRef<{ key: string; attempts: number; done: boolean } | null>(null);
  // True once the component's first commit has finished. The resume effect
  // (declared above this flip) sees `false` only on the mount run — a cold
  // open, whose first frames belong to the bottom start.
  const mountedRef = useRef(false);
  // Latest resume target, so a scheduled retry re-targets the anchor from the
  // rows the list holds when the retry fires (a prepended page shifts the
  // anchor's index) instead of from the rows at scroll time.
  const latestResumeRef = useRef<{
    key: string;
    anchorIds: readonly (string | null)[];
    resumeAnchor: string;
  } | null>(null);
  const resumeRetryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearResumeRetries = useCallback(() => {
    for (const timer of resumeRetryTimersRef.current) {
      clearTimeout(timer);
    }
    resumeRetryTimersRef.current = [];
  }, []);
  const scheduleResumeRetries = useCallback(
    (key: string) => {
      clearResumeRetries();
      for (const [retryIndex, delay] of RESUME_RETRY_DELAYS_MS.entries()) {
        const isLast = retryIndex === RESUME_RETRY_DELAYS_MS.length - 1;
        resumeRetryTimersRef.current.push(
          setTimeout(() => {
            const latest = latestResumeRef.current;
            if (latest === null || latest.key !== key) {
              return;
            }
            // The user has grabbed the transcript: the position is theirs now,
            // and the rest of the chain is moot — cancel it instead of letting
            // a later retry yank the list back to the recorded row after they
            // let go.
            if (userInteractedRef.current) {
              clearResumeRetries();
              return;
            }
            if (isUserScrollingRef.current) {
              return;
            }
            const index = latest.anchorIds.indexOf(latest.resumeAnchor);
            if (index !== -1) {
              // Every retry except the last keeps the tail follow suppressed:
              // FlashList's bottom-start re-assertions and this scroll's own
              // events would otherwise read "at the bottom" and re-arm the
              // follow, which then yanks the viewport back on the next
              // content-size change (device-proven resume loss).
              if (!isLast) {
                suppressAutoFollow(RESUME_RETRY_SUPPRESS_MS);
              }
              void listRef.current?.scrollToIndex({
                index,
                viewPosition: 0,
                viewOffset: 1,
                animated: false,
              });
            }
          }, delay)
        );
      }
    },
    [clearResumeRetries, isUserScrollingRef, listRef, suppressAutoFollow, userInteractedRef]
  );
  useEffect(() => clearResumeRetries, [clearResumeRetries]);
  useEffect(() => {
    if (resumeAnchor === null) {
      // No anchor to resume: any scheduled retries are moot.
      clearResumeRetries();
      return;
    }
    const key = `${sessionId}\u0000${resumeAnchor}`;
    latestResumeRef.current = { key, anchorIds, resumeAnchor };
    if (resumeStateRef.current?.key !== key) {
      resumeStateRef.current = { key, attempts: 0, done: false };
      clearResumeRetries();
    }
    const resume = resumeStateRef.current;
    if (resume.done) {
      return;
    }
    // `anchorIds` is built at render (see `getSessionTranscriptItemMessageId`):
    // this hook is generic for the list's other callers (quick chat, review
    // spectator); only the session screen passes `resumeAt`, always with
    // transcript items. The assertion is confined to that path.
    const plan = planResumeScroll({
      anchorIds,
      anchorMessageId: resumeAnchor,
      hasOlderMessages,
      olderLoadAttempts: resume.attempts,
    });
    if (plan.kind === 'scroll') {
      resume.done = true;
      // The user has grabbed the transcript: the position is theirs now, and
      // this scroll plus its retry chain would yank the list back to the
      // recorded row after they let go. End the resume, exactly as the retries
      // do when they see the same flag.
      if (userInteractedRef.current) {
        return;
      }
      // An in-flight drag (or momentum fling) must not be yanked either: the
      // immediate scroll honours the same guard the retries do. When it is
      // skipped the retry chain below still lands the anchor once the drag
      // ends, so nothing is lost.
      if (!isUserScrollingRef.current) {
        // Arm the suppression before any scroll this plan issues: FlashList's
        // bottom-start events (cold) or this scroll's own 5-step events (warm)
        // read "at the bottom" and would arm the tail follow, whose
        // content-size path no retry can out-race. The mount window bridges to
        // the first retry; the warm window covers the immediate scroll's event
        // settle and the first retry re-arms from there.
        suppressAutoFollow(
          mountedRef.current ? RESUME_RETRY_SUPPRESS_MS : RESUME_MOUNT_SUPPRESS_MS
        );
        // A cold open (anchor already a row at mount) does not scroll here: the
        // first layout has not measured its rows, so this scroll loses to
        // FlashList's own bottom-start initial scroll and to the estimate
        // settle. The scheduled retries land after both, under the measured
        // conditions the warm scroll is proven exact under. A warm open — an
        // anchor arriving on an already-mounted list — has measured rows and
        // scrolls immediately.
        if (mountedRef.current) {
          void listRef.current?.scrollToIndex({
            index: plan.index,
            viewPosition: 0,
            // One pixel into the anchor row: adjacent transcript rows overlap by
            // one pixel (device: row 30's frame bottom is row 31's top + 1), so a
            // scroll landing exactly on the row top leaves a 1px sliver of the
            // previous row as the first visible cell. One pixel down hides it and
            // keeps the anchor itself as the viewport's tracked first row.
            viewOffset: 1,
            animated: false,
          });
        }
      }
      scheduleResumeRetries(key);
      return;
    }
    if (plan.kind === 'load-older') {
      // A send took the position over while the anchor's page was in flight:
      // the resume ends here, exactly as the scroll and retry paths end it,
      // instead of paging for a position the send's output now owns.
      if (sendTakeoverRef.current) {
        resume.done = true;
        clearResumeRetries();
        return;
      }
      if (
        !shouldTriggerOlderMessagesLoad({
          hasOlderMessages,
          isLoadingOlderMessages,
          isInFlight: isInFlightRef.current,
          olderMessagesError,
        })
      ) {
        return;
      }
      // A prepended page makes FlashList re-anchor the viewport with its own
      // offset-correction scrolls, whose events read "at the bottom" while
      // the resume still waits in an older page. Bridge the suppression
      // across the request; the page landing re-runs this plan.
      suppressAutoFollow(RESUME_MOUNT_SUPPRESS_MS);
      resume.attempts += 1;
      onLoadOlderMessages();
      return;
    }
    resume.done = true;
  }, [
    sessionId,
    resumeAnchor,
    anchorIds,
    hasOlderMessages,
    isLoadingOlderMessages,
    olderMessagesError,
    onLoadOlderMessages,
    isInFlightRef,
    listRef,
    isUserScrollingRef,
    userInteractedRef,
    sendTakeoverRef,
    clearResumeRetries,
    scheduleResumeRetries,
    suppressAutoFollow,
  ]);
  // Flip after the resume effect: the mount run above must see `false`.
  useEffect(() => {
    mountedRef.current = true;
  }, []);
}
