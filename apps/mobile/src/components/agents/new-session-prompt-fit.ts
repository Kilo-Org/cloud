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

/** The geometry of the line a scrolled field cuts at one of its edges. */
export type ResolveComposerEdgeFadeHeightInput = {
  /** How far the clip edge sits into the field's text, from its first line box, in points. */
  clipEdgeOffset: number;
  /** The edge that cuts a line: the field's top or its bottom. */
  edge: 'top' | 'bottom';
  /** One text line's height, in points. */
  lineHeight: number;
  /** How far the band may reach past the hidden part, in points. `0` keeps it at the hidden part. */
  ramp: number;
};

/**
 * Height of the fade over the line a scrolled composer cuts, in points.
 *
 * A scrolled multiline field cuts one line at the edge the draft scrolls
 * through. That line's box is `L` tall; the part past the clip edge is
 * `hidden`, and the part still inside the field is `visible = L - hidden`. The
 * band is
 *
 *   `min(visible, hidden + min(hidden, ramp))`
 *
 * The band always covers the hidden part, which is the half of the glyphs the
 * edge slices: the clipped ascenders at the top edge and the clipped descenders
 * at the bottom edge (the 'g' in 'eight'). It then reaches one more `hidden`
 * into the visible part, capped at `ramp`, so a line that is only slightly cut
 * gets a band about twice its hidden part and the sliced glyph fades instead of
 * ending flat at full contrast against the edge. `ramp = 0` gives back
 * `min(visible, hidden)`.
 *
 * The band is never taller than `visible`, so it stays inside the cut line and
 * cannot dim the whole line above or below it. With `ramp` at a quarter line or
 * less, it is never taller than five eighths of a line. It is 0 where the clip
 * edge lands on a line boundary, so a whole line touching the edge mounts no
 * band and the band does not jump as the draft scrolls.
 *
 * iOS passes `ramp = L / 4`, so clipped descenders and ascenders fade. Android
 * passes `ramp = 0` and keeps the rule it shipped with, because its rendering is
 * not proven on a device and must not change.
 */
export function resolveComposerEdgeFadeHeight({
  clipEdgeOffset,
  edge,
  lineHeight,
  ramp,
}: ResolveComposerEdgeFadeHeightInput): number {
  'worklet';
  if (
    !Number.isFinite(clipEdgeOffset) ||
    !Number.isFinite(lineHeight) ||
    !Number.isFinite(ramp) ||
    lineHeight <= 0
  ) {
    return 0;
  }
  // Where the edge falls inside the cut line, and so how much of that line's box
  // is past the edge: the part above it at the top edge, the part below it at
  // the bottom edge.
  const intoLine = ((clipEdgeOffset % lineHeight) + lineHeight) % lineHeight;
  const hidden = edge === 'top' ? intoLine : (lineHeight - intoLine) % lineHeight;
  const visible = lineHeight - hidden;
  return Math.max(0, Math.min(visible, hidden + Math.min(hidden, Math.max(0, ramp))));
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
