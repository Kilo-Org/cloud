/**
 * Fits the new-session prompt's minimum height to the form frame it sits in.
 *
 * The prompt starts at a comfortable multi-line floor, but the form is a
 * `ScrollView` that shrinks with the keyboard and the safe areas, and the card
 * below the input is only as tall as the input plus its own chrome. When the
 * floor plus that chrome no longer fit the frame, the card's bottom row (the
 * attach/paste/voice controls) is pushed behind the bottom system bar. Yielding
 * the floor to whole lines keeps the entire card inside the frame, and whole
 * lines only, so the input never shows a clipped line.
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
    !Number.isFinite(preferredMinHeight) ||
    !Number.isFinite(lineHeight) ||
    !Number.isFinite(preferredLines) ||
    frameHeight <= 0 ||
    cardTop < 0 ||
    cardChromeHeight <= 0 ||
    preferredMinHeight <= 0 ||
    lineHeight <= 0 ||
    preferredLines < 1
  ) {
    return preferredMinHeight;
  }

  // The padding `preferredMinHeight` adds around its lines, derived from the
  // existing values instead of a second constant that could drift.
  const padding = preferredMinHeight - lineHeight * preferredLines;
  const available = frameHeight - cardTop - cardChromeHeight;
  const lines = Math.max(1, Math.floor((available - padding) / lineHeight));
  return Math.min(preferredMinHeight, lines * lineHeight + padding);
}
