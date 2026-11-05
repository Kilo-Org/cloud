// Body field geometry for the PR comment composers: max heights are
// whole-line multiples of the 20pt line box plus the field's own vertical
// inset, so the last visible line is never sliced mid-glyph; the
// keyboard-open cap keeps footer CTAs on-screen at scroll offset 0.
// BODY_MAX_LINES_CLOSED (10) leaves room to review a multi-paragraph comment
// without scrolling.
//
// The line box is set explicitly on the field (RN draws the platform's
// default ~1.3 line spacing otherwise), and RN heights are border-box, so
// the 1px top and bottom borders count toward the cap.
export const BODY_LINE_HEIGHT = 20;
export const BODY_VERTICAL_PADDING = 12;
export const BODY_BORDER_WIDTH = 1;
export const BODY_MAX_LINES_CLOSED = 10;
export const BODY_MAX_LINES_OPEN = 4;

/**
 * Whole-line max height for the body field: `lines × line box + vertical
 * padding + borders`, so the last visible line always ends on a whole row.
 */
export function resolveCommentBodyMaxHeight(lines: number): number {
  return lines * BODY_LINE_HEIGHT + BODY_VERTICAL_PADDING + 2 * BODY_BORDER_WIDTH;
}

export type CommentBodyOverflowInput = {
  /** Content height reported by the field's scroll view, or null before layout. */
  contentHeight: number | null;
  /** Frame height reported by onLayout, or null before layout. */
  frameHeight: number | null;
};

/**
 * Whether the bottom fade shows: the field scrolls only when its content is
 * taller than the frame. Content and frame heights come from the same scroll
 * view, so their comparison holds regardless of padding conventions.
 */
export function resolveCommentBodyFade({
  contentHeight,
  frameHeight,
}: CommentBodyOverflowInput): boolean {
  if (contentHeight === null || frameHeight === null) {
    return false;
  }
  return contentHeight > frameHeight + 0.5;
}
