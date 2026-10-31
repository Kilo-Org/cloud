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
  /**
   * The session this list is showing. A mounted list can switch sessions (the
   * Chat tab follows a conversation that moved onto a new session), and the new
   * one has to measure from its own first frame.
   */
  sessionId: string;
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
  sessionId,
  followTailAtMount,
  onContentSizeChange,
  onLayout,
}: OpenSettleParams): OpenSettle {
  const [openSettled, setOpenSettled] = useState(!followTailAtMount);
  // Render-phase reset for a list that switched sessions: the state belongs to
  // the session whose rows it describes.
  const [settledForSessionId, setSettledForSessionId] = useState(sessionId);
  if (settledForSessionId !== sessionId) {
    setSettledForSessionId(sessionId);
    setOpenSettled(!followTailAtMount);
  }
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
    // Nothing measured yet: the quiet window only means something once the list
    // has reported both a content height and a viewport, or a slow first
    // measurement would let the rows paint before their position is final. The
    // cap in the effect still reveals a list that never reports either.
    const content = contentHeightRef.current;
    const viewport = viewportHeightRef.current;
    if (content <= 0 || viewport <= 0) {
      return;
    }
    // No fast path for a transcript that fits the viewport: the first reported
    // content height is a measurement in progress, not a verdict, and a short
    // transcript can report a fitting height before the rest of its rows land.
    // The quiet window is short enough to cover both cases.
    clearQuietTimer();
    quietTimerRef.current = setTimeout(() => {
      quietTimerRef.current = null;
      setOpenSettled(true);
    }, OPEN_SETTLE_QUIET_MS);
  }, [clearQuietTimer]);

  useEffect(() => {
    if (openSettled) {
      clearQuietTimer();
      return undefined;
    }
    const cap = setTimeout(() => {
      setOpenSettled(true);
    }, OPEN_SETTLE_LIMIT_MS);
    // A previous session's content height, and any window armed from it, do not
    // describe this one. The viewport survives the switch: React Native fires
    // `onLayout` only when the frame changes, and a list that swaps sessions in
    // place keeps the frame it measured.
    contentHeightRef.current = 0;
    clearQuietTimer();
    return () => {
      clearTimeout(cap);
      clearQuietTimer();
    };
  }, [clearQuietTimer, openSettled, sessionId]);

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
