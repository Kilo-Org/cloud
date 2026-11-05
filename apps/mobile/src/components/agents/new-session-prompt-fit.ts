/**
 * Fits the new-session prompt's height to the form frame it sits in.
 *
 * The prompt is one size whatever the draft holds: a comfortable multi-line
 * floor, lowered only to whole lines when the form's `ScrollView` — which
 * shrinks with the keyboard and the safe areas — can no longer hold the floor
 * plus the card's own chrome. Yielding in whole lines keeps the entire card
 * inside the frame, and the input never shows a clipped line; a draft taller
 * than the field scrolls inside it instead of growing the card.
 *
 * Sizing the field to its text was the defect: the stored draft loads a moment
 * after the screen opens, so the card grew then and every row below it moved by
 * that growth. A height that does not depend on the draft cannot do that.
 *
 * Pure: it reads no layout and mutates nothing, so the caller can recompute it
 * on every frame change without shifting layout on load, refresh, or retry.
 */

export type ResolveComposerTopFadeHeightInput = {
  /** How far the field's text has scrolled above its text box, in points. */
  scrollOffset: number;
  /** One text line's height, in points. */
  lineHeight: number;
};

/**
 * Height of the top fade over the composer input, in points.
 *
 * A scrolled multiline field cuts its topmost line at the text box's top edge.
 * With line boxes `L` tall and the field scrolled by `y` into one of them, the
 * fragment left at the top is the bottom `L - y` of that line, and the next
 * whole line begins exactly `L - y` below the top edge. The fade has to cover
 * the fragment and must not reach the whole line under it, so it is the
 * smaller of the two: `min(y, L - y)`.
 *
 * That band is never taller than half a line, so a readable line is never
 * dimmed — the failure of both a fixed one-line fade (it washes the first line
 * of any overflowing draft) and a fade sized to the offset alone (past the
 * halfway point it swallows the whole next line). It is 0 at the top of the
 * field, where nothing is cut.
 */
export function resolveComposerTopFadeHeight({
  scrollOffset,
  lineHeight,
}: ResolveComposerTopFadeHeightInput): number {
  'worklet';
  if (!Number.isFinite(scrollOffset) || !Number.isFinite(lineHeight) || lineHeight <= 0) {
    return 0;
  }
  const intoLine = scrollOffset % lineHeight;
  return Math.max(0, Math.min(intoLine, lineHeight - intoLine));
}

/**
 * Shortest window that still shows the form's whole first screenful at the
 * preferred floor, in points.
 *
 * Measured on the design gate's compact cell — 360x640 dp at the default
 * density, text size and font scale — where the form's viewport ended at
 * 524.57 points and the repository picker's bottom edge at 568.38: the header
 * and the pinned Start footer take the other 115.43 of the 640. The three-line
 * floor therefore needs 683.81 points of window to show the whole trigger,
 * which is 44.19 points tall and gets 48 back from one line. A shorter window
 * does not hold it and takes the one-line floor.
 *
 * A height rule, not a portrait rule: a landscape phone is short too and takes
 * the one-line floor, and only a taller window keeps the preferred floor.
 */
const NEW_SESSION_FIRST_SCREENFUL_MIN_WINDOW_HEIGHT = 684;

/** The smallest floor the fit allows, in lines. */
const NEW_SESSION_SHORT_WINDOW_LINES = 1;

export type ResolveNewSessionPromptLineCountInput = {
  /** The window's height in points, as `useWindowDimensions` reports it. */
  windowHeight: number;
  /** True while the keyboard is visible, when the frame and not the window decides. */
  keyboardVisible: boolean;
  /** The floor a window with room keeps, in lines. */
  preferredLines: number;
};

/**
 * Lines the prompt reserves on this window.
 *
 * The composer keeps its preferred floor wherever the form's first screenful
 * can hold the repository picker under it. On a shorter window it takes one
 * line, so the picker Start needs is visible without a scroll. The form still
 * scrolls, so the yield only decides what the first screenful shows.
 *
 * The keyboard is the frame's problem, not the window's: the
 * `KeyboardAvoidingView` shrinks the frame to the room above the keyboard and
 * the fit helper lowers the floor to it. Reserving the yield there as well
 * would pin a tall phone's composer to one line while the user types, so the
 * window rule stands aside.
 *
 * The window, not the measured frame, decides: a decision that waited for the
 * frame reflowed the form about two seconds after first paint on the emulator.
 * An unknown height keeps the preferred floor, because the yield is the
 * exception, never the default.
 */
export function resolveNewSessionPromptLineCount({
  windowHeight,
  keyboardVisible,
  preferredLines,
}: ResolveNewSessionPromptLineCountInput): number {
  if (keyboardVisible || !Number.isFinite(windowHeight) || windowHeight <= 0) {
    return preferredLines;
  }
  return windowHeight < NEW_SESSION_FIRST_SCREENFUL_MIN_WINDOW_HEIGHT
    ? NEW_SESSION_SHORT_WINDOW_LINES
    : preferredLines;
}

export type ResolveNewSessionPromptMinHeightInput = {
  /** Height of the scrollable form frame the prompt sits in, in points. */
  frameHeight: number;
  /** The card's top offset inside that frame, in points. */
  cardTop: number;
  /** Everything the card renders other than the input itself, in points. */
  cardChromeHeight: number;
  /** The multi-line floor used whenever the frame has room, in points. */
  preferredMinHeight: number;
  /** One text line's height at the current Dynamic Type scale, in points. */
  lineHeight: number;
  /** Number of lines `preferredMinHeight` reserves. */
  preferredLines: number;
};

/**
 * Largest whole-line height that still fits the space the frame leaves for the
 * input, clamped to `preferredMinHeight` so a roomy frame keeps the preferred
 * floor. Never returns fewer than one line. An unknown or non-positive
 * measurement (the first layout pass, a hidden frame) returns
 * `preferredMinHeight` unchanged, so the prompt renders at its preferred floor
 * until the frame is measurable.
 */
export function resolveNewSessionPromptMinHeight({
  frameHeight,
  cardTop,
  cardChromeHeight,
  preferredMinHeight,
  lineHeight,
  preferredLines,
}: ResolveNewSessionPromptMinHeightInput): number {
  if (
    !Number.isFinite(frameHeight) ||
    !Number.isFinite(cardTop) ||
    !Number.isFinite(cardChromeHeight) ||
    !Number.isFinite(lineHeight) ||
    frameHeight <= 0 ||
    cardTop < 0 ||
    cardChromeHeight <= 0 ||
    lineHeight <= 0 ||
    !Number.isFinite(preferredMinHeight) ||
    !Number.isFinite(preferredLines) ||
    preferredMinHeight <= 0 ||
    preferredLines < 1
  ) {
    return preferredMinHeight;
  }

  // The padding `preferredMinHeight` adds around its lines, derived from the
  // existing values instead of a second constant that could drift.
  const verticalPadding = preferredMinHeight - lineHeight * preferredLines;
  const available = frameHeight - cardTop - cardChromeHeight;
  const lines = Math.max(1, Math.floor((available - verticalPadding) / lineHeight));
  return Math.min(preferredMinHeight, lines * lineHeight + verticalPadding);
}

export function resolveNewSessionFormFrameHeight({
  containerY,
  containerHeight,
  footerHeight,
  windowHeight,
  keyboardHeight,
  keyboardVerticalOffset,
}: {
  containerY: number;
  containerHeight: number;
  footerHeight: number;
  windowHeight: number;
  keyboardHeight: number;
  keyboardVerticalOffset: number;
}): number {
  const keyboardTop = windowHeight - keyboardHeight - keyboardVerticalOffset;
  const overlap = Math.max(0, containerY + containerHeight - keyboardTop);
  return Math.max(0, containerHeight - footerHeight - overlap);
}
