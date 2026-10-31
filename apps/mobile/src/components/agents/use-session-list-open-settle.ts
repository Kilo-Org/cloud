import { type LayoutChangeEvent } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A transcript does not paint in its final position on its first frame. The
 * list lays the rows out at their natural offsets, applies the bottom-start
 * adjustment margin, and only then scrolls to the newest row. Measured on the
 * device, the time marker above the newest rows, and every row around it, moves
 * by the transcript's whole overflow a beat after the rows were already on
 * screen.
 *
 * This hook answers one question for the list: are the rows final yet? It says
 * no while the content keeps changing height or the viewport keeps changing,
 * and yes once both have been still for a quiet window. The list stays behind
 * the loading skeleton until then, so the first frame the transcript is seen in
 * is the position it keeps.
 *
 * An anchored open (`?at=`) is not following the tail: it lands on its own row
 * through the resume schedule, so it starts settled and reveals at once.
 */
const OPEN_SETTLE_QUIET_MS = 150;

/**
 * The quiet window is what normally reveals the rows. This cap only exists so a
 * list that never stops measuring cannot hide the transcript.
 */
const OPEN_SETTLE_LIMIT_MS = 1500;

type OpenSettleParams = Readonly<{
  /** Whether this open follows the newest row (the tail) rather than an anchor. */
  followTailAtMount: boolean;
  /** The list's own content-size handler. */
  onContentSizeChange: (width: number, height: number) => void;
  /** The list's own layout handler. */
  onLayout: (event: LayoutChangeEvent) => void;
}>;

type OpenSettle = Readonly<{
  /** False while the transcript's rows are still measuring. */
  openSettled: boolean;
  handleContentSizeChange: (width: number, height: number) => void;
  handleListLayout: (event: LayoutChangeEvent) => void;
}>;

export function useSessionListOpenSettle({
  followTailAtMount,
  onContentSizeChange,
  onLayout,
}: OpenSettleParams): OpenSettle {
  const [openSettled, setOpenSettled] = useState(!followTailAtMount);
  const settledRef = useRef(openSettled);
  settledRef.current = openSettled;
  const contentHeightRef = useRef(0);
  const viewportHeightRef = useRef(0);
  const quietTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearQuietTimer = useCallback(() => {
    const timer = quietTimerRef.current;
    if (timer !== null) {
      clearTimeout(timer);
      quietTimerRef.current = null;
    }
  }, []);

  const armQuietTimer = useCallback(() => {
    if (settledRef.current) {
      return;
    }
    // A transcript that fits its viewport has nothing to pin, so it is final on
    // its first layout and must not be held back at all.
    const fits =
      contentHeightRef.current > 0 && contentHeightRef.current <= viewportHeightRef.current;
    if (fits) {
      clearQuietTimer();
      setOpenSettled(true);
      return;
    }
    clearQuietTimer();
    quietTimerRef.current = setTimeout(() => {
      quietTimerRef.current = null;
      setOpenSettled(true);
    }, OPEN_SETTLE_QUIET_MS);
  }, [clearQuietTimer]);

  useEffect(() => {
    const cap = settledRef.current
      ? null
      : setTimeout(() => {
          setOpenSettled(true);
        }, OPEN_SETTLE_LIMIT_MS);
    armQuietTimer();
    return () => {
      if (cap !== null) {
        clearTimeout(cap);
      }
      clearQuietTimer();
    };
  }, [armQuietTimer, clearQuietTimer]);

  const handleContentSizeChange = useCallback(
    (width: number, height: number) => {
      contentHeightRef.current = height;
      armQuietTimer();
      onContentSizeChange(width, height);
    },
    [armQuietTimer, onContentSizeChange]
  );

  const handleListLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewportHeightRef.current = event.nativeEvent.layout.height;
      armQuietTimer();
      onLayout(event);
    },
    [armQuietTimer, onLayout]
  );

  return { openSettled, handleContentSizeChange, handleListLayout };
}
