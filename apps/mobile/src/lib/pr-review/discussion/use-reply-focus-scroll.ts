import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { Keyboard } from 'react-native';

import { type FlashListRef } from '@shopify/flash-list';

import { type DiscussionListItem } from './review-discussion-types';

export type ReplyFocusScroll = {
  /** Record the focused thread row (its list index) and scroll it when safe. */
  markFocus: (index: number) => void;
  /**
   * Feed the list's viewport layout commits into the hook (wire to the
   * FlashList `onLayout`). The focused row is anchored against the COMMITTED
   * viewport, never a guessed frame.
   */
  onViewportLayout: (height: number) => void;
  /**
   * The user grabbed the list: their scroll intent wins, drop any parked
   * focus scroll (wire to the FlashList `onScrollBeginDrag`).
   */
  invalidate: () => void;
};

/**
 * Keeps the focused inline reply above the keyboard-lifted bottom Comment CTA
 * bar while the keyboard is open.
 *
 * Android is the exposed case: with edge-to-edge, `adjustResize` no longer
 * resizes the window and `automaticallyAdjustKeyboardInsets` is iOS-only, so
 * the keyboard-open lift of the CTA bar (AppAwareKeyboardPaddingView) just
 * shrinks the list viewport under the focused row — the reply input and its
 * submit button end up behind the lifted CTA with nothing scrolling them back
 * into view. The fix scrolls the focused thread row so its BOTTOM (the reply
 * input + submit button) aligns with the viewport bottom, just above the CTA.
 *
 * The scroll must run against the COMMITTED viewport. The earlier one-frame
 * guess after `keyboardDidShow` parked the row against the pre-lift viewport
 * when the CTA's padding layout landed later, and the submit button stayed
 * behind the lifted CTA (uxs3 spot check, e7-typed). Platforms commit in
 * opposite orders: the Android lift (on `keyboardDidShow`) lands AFTER the
 * show event, the iOS lift (on `keyboardWillShow`) lands BEFORE it. So the
 * hook scrolls once the viewport is known settled: on `keyboardDidShow` when
 * a height-change commit already landed since the focus (iOS), or on the
 * first height-change commit after the show (Android). A focus that arrives
 * while the keyboard is up scrolls immediately — that viewport is committed.
 * Exactly one scroll per focus; a user drag wins over the park.
 */
export function useReplyFocusScroll(
  listRef: RefObject<FlashListRef<DiscussionListItem> | null>
): ReplyFocusScroll {
  // The focused row awaiting its scroll (null = none pending).
  const pendingIndexRef = useRef<number | null>(null);
  const keyboardVisibleRef = useRef(false);
  // A viewport height-change landed while a focus was pending.
  const viewportCommittedRef = useRef(false);
  const lastHeightRef = useRef(0);

  const scrollRowToViewportBottom = useCallback(
    (index: number) => {
      pendingIndexRef.current = null;
      viewportCommittedRef.current = false;
      // One frame out: the layout commit that landed this path has applied,
      // but FlashList's own window-size bookkeeping updates in the same
      // pass — the scroll reads it on the next frame.
      requestAnimationFrame(() => {
        void listRef.current?.scrollToIndex({ index, viewPosition: 1, animated: false });
      });
    },
    [listRef]
  );

  useEffect(() => {
    // The did-events fire on both platforms (iOS additionally emits the
    // will-events; Android only the did-events), and the scroll must run
    // after the keyboard is fully up anyway — the CTA bar's lift is still
    // animating on willShow — so one did-event listener serves both.
    const show = Keyboard.addListener('keyboardDidShow', () => {
      keyboardVisibleRef.current = true;
      // iOS: the lift already committed before this event — the viewport is
      // settled, scroll now. Android: the lift commits after it — wait for
      // the commit in onViewportLayout instead.
      if (pendingIndexRef.current !== null && viewportCommittedRef.current) {
        scrollRowToViewportBottom(pendingIndexRef.current);
      }
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      keyboardVisibleRef.current = false;
      viewportCommittedRef.current = false;
      pendingIndexRef.current = null;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [scrollRowToViewportBottom]);

  const markFocus = useCallback(
    (index: number) => {
      pendingIndexRef.current = index;
      viewportCommittedRef.current = false;
      if (!keyboardVisibleRef.current) {
        return;
      }
      // Focus landed while the keyboard was already up (tap into a second
      // reply field): the viewport is committed, so scroll now.
      scrollRowToViewportBottom(index);
    },
    [scrollRowToViewportBottom]
  );

  const onViewportLayout = useCallback(
    (height: number) => {
      const previous = lastHeightRef.current;
      lastHeightRef.current = height;
      // The CTA lift shrinks the list frame: the height CHANGING commit is
      // the viewport to anchor against. A same-height event is a re-layout,
      // and the very first layout is the unlifted baseline.
      const heightChanged = previous !== 0 && previous !== height;
      if (!heightChanged || pendingIndexRef.current === null) {
        return;
      }
      if (keyboardVisibleRef.current) {
        // Android: the lift just committed on top of the open keyboard.
        scrollRowToViewportBottom(pendingIndexRef.current);
      } else {
        // iOS: the lift commits while the keyboard is still animating in;
        // `keyboardDidShow` fires next and scrolls against this commit.
        viewportCommittedRef.current = true;
      }
    },
    [scrollRowToViewportBottom]
  );

  const invalidate = useCallback(() => {
    pendingIndexRef.current = null;
    viewportCommittedRef.current = false;
  }, []);

  return { markFocus, onViewportLayout, invalidate };
}
