// Body field geometry for the PR comment composers: max heights are
// whole-line multiples of the 20pt line box (`text-sm leading-5`) plus the
// 12pt vertical padding (`py-1.5`), so the last visible line is never sliced
// mid-glyph; the keyboard-open cap keeps footer CTAs on-screen at scroll
// offset 0. BODY_MAX_LINES_CLOSED (10) leaves room to review a
// multi-paragraph comment without scrolling.
export const BODY_LINE_HEIGHT = 20;
export const BODY_VERTICAL_PADDING = 12;
export const BODY_MAX_LINES_CLOSED = 10;
export const BODY_MAX_LINES_OPEN = 4;

/**
 * Whole-line max height for the body field: `lines × line box + vertical
 * padding`, so the last visible line always ends on a whole row.
 */
export function resolveCommentBodyMaxHeight(lines: number): number {
  return lines * BODY_LINE_HEIGHT + BODY_VERTICAL_PADDING;
}

export type CommentBodyOverflowInput = {
  /** Content height reported by the field's scroll view, or null before layout. */
  contentHeight: number | null;
  /** Frame height reported by onLayout, or null before layout. */
  frameHeight: number | null;
  /** The scroll position shows the last line fully. */
  atBottom: boolean;
};

/**
 * Whether the bottom fade shows. Content and frame heights come from the same
 * scroll view, so `content > frame` means the field scrolls regardless of
 * padding conventions; the fade hides once the last line is in view.
 */
export function resolveCommentBodyFade({
  contentHeight,
  frameHeight,
  atBottom,
}: CommentBodyOverflowInput): boolean {
  if (contentHeight === null || frameHeight === null || atBottom) {
    return false;
  }
  return contentHeight > frameHeight + 0.5;
}
