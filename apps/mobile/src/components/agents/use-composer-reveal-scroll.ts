import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { Keyboard, type ScrollView } from 'react-native';

/**
 * The minimum content offset that puts the composer card's bottom edge at the
 * scroll viewport's bottom, or `0` when the card already fits (or either
 * measurement is not committed yet). `ceil` keeps the card's last pixel above
 * the viewport edge; a larger offset would hide the input's first line, so this
 * is the single source of the reveal offset.
 */
export function resolveComposerRevealOffset({
  viewportHeight,
  composerTop,
  composerHeight,
}: {
  viewportHeight: number;
  composerTop: number;
  composerHeight: number;
}): number {
  if (viewportHeight <= 0 || composerHeight <= 0) {
    return 0;
  }
  return Math.max(0, Math.ceil(composerTop + composerHeight - viewportHeight));
}

export type ComposerRevealScroll = {
  /** The scroll body's ref; the reveal scrolls this view. */
  scrollRef: RefObject<ScrollView | null>;
  /** Feed the scroll body's layout height (wire to the ScrollView `onLayout`). */
  onViewportLayout(height: number): void;
  /** Feed the composer card's layout (wire to its wrapper `onLayout`). */
  onComposerLayout(layout: { y: number; height: number }): void;
  /** Feed the user's live content offset (wire to the ScrollView `onScroll`). */
  onScroll(offset: number): void;
  /** The user grabbed the scroll body: their intent wins for this keyboard session. */
  onUserScroll(): void;
};

/**
 * Reveals the composer card's bottom row (the mode/model pills) above the soft
 * keyboard on the New session screen.
 *
 * Explorer finding `new-session-filled-kb-up` (revision `f2181ae79`, capture
 * `explorer-new-session-filled-kb-up-the-mode-and-model-pill-6709164d`): with
 * the keyboard up, the composer's mode/model pill row is clipped by the IME's
 * top edge — only the top of the pills shows — while the same row is fully
 * visible with the keyboard down.
 *
 * The keyboard-lift view (`AppAwareKeyboardPaddingView`) shrinks the scroll
 * frame to end exactly at the IME's top edge, but the content offset stays `0`:
 * the composer card is the first child, so its bottom falls below that clip
 * line. `automaticallyAdjustKeyboardInsets` only scrolls the FOCUSED input into
 * view and is inert on Android, and the input's 3-line minimum floors the
 * card's height, so the pills stay hidden. This hook changes only the scroll
 * offset — never a size — so no surrounding layout moves.
 *
 * The scroll must run against the COMMITTED viewport and card. Android commits
 * the lift AFTER `keyboardDidShow` (the padding view uses the did-events there),
 * iOS BEFORE it (the will-events), so the show event and the two layout commits
 * all call `reveal()`; whichever lands last wins and the others are no-ops.
 *
 * Two rules keep the keyboard-down rendering intact:
 *
 * - The drag flag is scoped to the keyboard session. `keyboardDidShow` starts a
 *   session and clears any grab made while the keyboard was down, so a scroll
 *   of the tall form before the next focus cannot suppress the reveal — that
 *   grab belongs to a dead session. A grab DURING the session still wins for
 *   the rest of it.
 * - The session's first reveal captures the offset the user's own scroll had
 *   reached, and `keyboardDidHide` scrolls it back. The form is far taller than
 *   the lifted viewport, so without the restore the keyboard-down view returns
 *   scrolled — the card's top edge (rounded corner, top padding, the prompt's
 *   first line) clipped under the header. A drag that overruled the reveal
 *   keeps the user's position: their offset is what the hide gives back.
 *
 * A card that shrinks back to fit the lifted viewport (deleted lines, a removed
 * attachment, a models error resolving) must not leave the body parked at the
 * old reveal offset: the reveal offset is valid only while the card is taller
 * than the viewport, so the shrink returns the user's own offset immediately.
 */
export function useComposerRevealScroll(): ComposerRevealScroll {
  const scrollRef = useRef<ScrollView | null>(null);
  const keyboardVisibleRef = useRef(false);
  const userDraggedRef = useRef(false);
  const viewportHeightRef = useRef(0);
  const composerLayoutRef = useRef({ y: 0, height: 0 });
  const currentOffsetRef = useRef(0);
  const revealedRef = useRef(false);
  const preRevealOffsetRef = useRef<number | null>(null);

  const reveal = useCallback(() => {
    if (!keyboardVisibleRef.current || userDraggedRef.current) {
      return;
    }
    const viewportHeight = viewportHeightRef.current;
    const composerHeight = composerLayoutRef.current.height;
    if (viewportHeight <= 0 || composerHeight <= 0) {
      // Measurements not committed yet: a zero offset here would be a guess,
      // so leave the offset alone and let the layout commit call again.
      return;
    }
    const offset = resolveComposerRevealOffset({
      viewportHeight,
      composerTop: composerLayoutRef.current.y,
      composerHeight,
    });
    if (offset === 0) {
      // The card fits the lifted viewport again (lines deleted, an attachment
      // removed, a models error resolved): the reveal offset is now stale, so
      // give the user's own offset back — otherwise the card's top (rounded
      // corner, top padding, the prompt's first line) stays clipped under the
      // header for the rest of the session.
      if (revealedRef.current) {
        scrollRef.current?.scrollTo({ y: preRevealOffsetRef.current ?? 0, animated: false });
        revealedRef.current = false;
        preRevealOffsetRef.current = null;
      }
      return;
    }
    if (!revealedRef.current) {
      // The user's own offset at the session's first reveal is the one the hide
      // gives back; a re-reveal (e.g. the card grew) keeps the original capture.
      preRevealOffsetRef.current = currentOffsetRef.current;
      revealedRef.current = true;
    }
    scrollRef.current?.scrollTo({ y: offset, animated: false });
  }, []);

  useEffect(() => {
    // The did-events fire on both platforms and the reveal must run after the
    // keyboard is fully up anyway, so one listener pair serves both.
    const show = Keyboard.addListener('keyboardDidShow', () => {
      // A new keyboard session: a grab made while the keyboard was down must
      // not suppress this session's reveal.
      keyboardVisibleRef.current = true;
      userDraggedRef.current = false;
      revealedRef.current = false;
      preRevealOffsetRef.current = null;
      reveal();
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      // Read the drag flag before clearing it: a drag that overruled the reveal
      // leaves the user in control of the offset.
      const userDragged = userDraggedRef.current;
      if (revealedRef.current && !userDragged && preRevealOffsetRef.current !== null) {
        // The lifted viewport grows back on hide; without this the tall form
        // stays parked at the reveal offset and the card's top is clipped.
        scrollRef.current?.scrollTo({ y: preRevealOffsetRef.current, animated: false });
      }
      keyboardVisibleRef.current = false;
      revealedRef.current = false;
      preRevealOffsetRef.current = null;
      userDraggedRef.current = false;
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [reveal]);

  const onViewportLayout = useCallback(
    (height: number) => {
      viewportHeightRef.current = height;
      reveal();
    },
    [reveal]
  );

  const onComposerLayout = useCallback(
    (layout: { y: number; height: number }) => {
      composerLayoutRef.current = layout;
      reveal();
    },
    [reveal]
  );

  const onUserScroll = useCallback(() => {
    userDraggedRef.current = true;
  }, []);

  const onScroll = useCallback((offset: number) => {
    currentOffsetRef.current = offset;
  }, []);

  return { scrollRef, onViewportLayout, onComposerLayout, onScroll, onUserScroll };
}
