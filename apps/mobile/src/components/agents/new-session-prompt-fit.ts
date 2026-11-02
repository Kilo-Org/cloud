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
