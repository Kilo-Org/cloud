/**
 * Fits the new-session prompt's height to the form frame it sits in.
 *
 * The prompt starts at a comfortable multi-line floor, but the form is a
 * `ScrollView` that shrinks with the keyboard and the safe areas, and the card
 * below the input is only as tall as the input plus its own chrome. When the
 * floor plus that chrome no longer fit the frame, the card's bottom row (the
 * attach/paste/voice controls) is pushed behind the bottom system bar. Yielding
 * the floor to whole lines keeps the entire card inside the frame, and whole
 * lines only, so the input never shows a clipped line.
 *
 * The frame also carries the block directly under the card — the Organization
 * section when the entry renders one, then the Run on selector and its refresh
 * control — which should stay readable and tappable while the keyboard is up. A
 * long draft grows the input to its cap, and a cap taken from the window alone
 * then fills the whole frame and cuts that row at the frame's bottom edge. So
 * the cap is taken from the room the frame leaves after the card's own chrome,
 * that block, and a line of air under it, and the block is reserved only while
 * the input can still keep its floor beside it: whole lines only, a frame too
 * short for both would otherwise cost the composer most of its lines, and the
 * block then comes into view with the form's own drag instead.
 *
 * Both guards matter on the shipped form, where the block measures 167pt with
 * the keyboard up (Organization 80pt, Run on row 89pt): reserving it beside the
 * three-line floor needs a 395pt frame. The Android emulator reports 339pt with
 * its keyboard up, so there the cap falls back to the room the card alone needs
 * and the row is reached with the drag; a shorter keyboard, or a taller window,
 * leaves the frame the reserve needs and keeps the row inside it.
 *
 * Pure: it reads no layout and mutates nothing, so the caller can recompute it
 * on every frame change without shifting layout on load, refresh, or retry.
 */

export type ResolveNewSessionPromptFrameFitInput = {
  /** Height of the scrollable form frame the prompt sits in, in points. */
  frameHeight: number;
  /** The card's top offset inside that frame, in points. */
  cardTop: number;
  /** Everything the card renders other than the input itself, in points. */
  cardChromeHeight: number;
  /**
   * The block directly under the card that the frame must still show, in
   * points. The new-session form reports the Run on row (its `mt-5`, the label,
   * its `mb-2`, and the selector or target line) here; `0` means the frame owes
   * nothing below the card.
   */
  belowCardHeight: number;
  /** Air kept between that block and the frame's bottom edge, in points; unset means none. */
  clearanceHeight?: number;
  /** One text line's height at the current Dynamic Type scale, in points. */
  lineHeight: number;
  /** The input's own vertical padding, in points. */
  verticalPadding: number;
};

/**
 * The largest whole-line input height the frame leaves once the card's chrome,
 * the block under the card, and the requested clearance are taken out, or
 * `null` when a measurement is missing or unusable (the first layout pass, a
 * hidden frame). Every result is a whole number of lines plus the padding, and
 * never fewer than one line, so the input never shows a clipped line and a
 * cramped frame still renders a readable one.
 */
export function resolveNewSessionPromptFrameFit({
  frameHeight,
  cardTop,
  cardChromeHeight,
  belowCardHeight,
  clearanceHeight = 0,
  lineHeight,
  verticalPadding,
}: ResolveNewSessionPromptFrameFitInput): number | null {
  if (
    !Number.isFinite(frameHeight) ||
    !Number.isFinite(cardTop) ||
    !Number.isFinite(cardChromeHeight) ||
    !Number.isFinite(belowCardHeight) ||
    !Number.isFinite(clearanceHeight) ||
    !Number.isFinite(lineHeight) ||
    !Number.isFinite(verticalPadding) ||
    frameHeight <= 0 ||
    cardTop < 0 ||
    cardChromeHeight <= 0 ||
    belowCardHeight < 0 ||
    clearanceHeight < 0 ||
    lineHeight <= 0 ||
    verticalPadding < 0
  ) {
    return null;
  }

  const available = frameHeight - cardTop - cardChromeHeight - belowCardHeight - clearanceHeight;
  const lines = Math.max(1, Math.floor((available - verticalPadding) / lineHeight));
  return lines * lineHeight + verticalPadding;
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
 *
 * The Run on block under the card is deliberately not part of this fit: whole
 * lines only, the block costs the phone's composer its floor where the frame
 * cannot hold both, and the shorter composer is the worse trade there (see
 * `resolveNewSessionPromptMaxHeight`, which reserves the block when the floor
 * still fits beside it).
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
  const fitted = resolveNewSessionPromptFrameFit({
    frameHeight,
    cardTop,
    cardChromeHeight,
    belowCardHeight: 0,
    lineHeight,
    verticalPadding,
  });
  return fitted === null ? preferredMinHeight : Math.min(preferredMinHeight, fitted);
}

export type ResolveNewSessionPromptMaxHeightInput = {
  /** Height of the scrollable form frame the prompt sits in, in points. */
  frameHeight: number;
  /** The card's top offset inside that frame, in points. */
  cardTop: number;
  /** Everything the card renders other than the input itself, in points. */
  cardChromeHeight: number;
  /** The block under the card the frame must still show, in points; unset means none. */
  belowCardHeight?: number;
  /** The cap the window math already allows, in points. */
  preferredMaxHeight: number;
  /** The floor the caller renders the input at; the cap never drops below it. */
  minHeight: number;
  /** One text line's height at the current Dynamic Type scale, in points. */
  lineHeight: number;
  /** The input's own vertical padding, in points. */
  verticalPadding: number;
};

/**
 * The input's cap inside the frame: `preferredMaxHeight` while the frame has
 * room, else the largest whole-line height the frame leaves.
 *
 * The Run on block under the card is reserved — the cap keeps the card's
 * chrome, the block, and one line of air under it inside the frame — but only
 * while the input can still keep `minHeight` beside it. Where whole lines
 * cannot hold both (the Android emulator with its keyboard up: 339pt of frame,
 * 14pt card top, 101.33pt card chrome and the 167pt block leave one line),
 * reserving the block would cost the composer most of its lines for every
 * draft, so the floor wins and the cap falls back to the room the card alone
 * needs. The block then comes into view with the form's own drag, which is the
 * behaviour the Run on finding accepts alongside "stays fully visible".
 *
 * Never below `minHeight`, and an unknown or non-positive measurement returns
 * `preferredMaxHeight` unchanged, which keeps the window-only cap until the
 * frame is measurable.
 */
export function resolveNewSessionPromptMaxHeight({
  frameHeight,
  cardTop,
  cardChromeHeight,
  belowCardHeight = 0,
  preferredMaxHeight,
  minHeight,
  lineHeight,
  verticalPadding,
}: ResolveNewSessionPromptMaxHeightInput): number {
  if (
    !Number.isFinite(preferredMaxHeight) ||
    !Number.isFinite(minHeight) ||
    preferredMaxHeight <= 0 ||
    minHeight < 0
  ) {
    return preferredMaxHeight;
  }

  const withBlock = resolveNewSessionPromptFrameFit({
    frameHeight,
    cardTop,
    cardChromeHeight,
    belowCardHeight,
    clearanceHeight: lineHeight,
    lineHeight,
    verticalPadding,
  });
  if (withBlock === null) {
    return preferredMaxHeight;
  }
  if (withBlock >= minHeight) {
    return Math.min(preferredMaxHeight, withBlock);
  }

  const cardOnly = resolveNewSessionPromptFrameFit({
    frameHeight,
    cardTop,
    cardChromeHeight,
    belowCardHeight: 0,
    lineHeight,
    verticalPadding,
  });
  if (cardOnly === null) {
    return preferredMaxHeight;
  }
  return Math.min(preferredMaxHeight, Math.max(cardOnly, minHeight));
}
