/**
 * The Android markdown renderer resolves each paragraph's direction from its
 * first strong character and draws a list item's marker and indent on that
 * paragraph's leading edge. A list style carries no alignment of its own, so a
 * reply in the interface's script aligns to the start edge while its bullets
 * stay on the left. Naming the start edge inside each item's own text moves the
 * marker, the indent and the wrapped lines to the same edge as the heading and
 * every other paragraph of the turn; the item's words still read left to right.
 *
 * The mark is a right-to-left mark (U+200F), a strong character with no width,
 * so it changes the paragraph's direction without drawing or speaking anything.
 */
const RIGHT_TO_LEFT_MARK = '\u200F';

/**
 * Up to three spaces and one or more blockquote markers in front of a line's
 * content. At least one marker is required: without it the pattern would also
 * eat the indentation of an unquoted line, and a fence indented deeper than a
 * closer allows would end the block it is code inside.
 */
const BLOCKQUOTE = /^[ \t]{0,3}(?:>[ \t]?)+/;

/** A fence opener: up to three spaces, then three or more marks and an info string. */
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** A fence closer: the same shape with nothing after the marks. */
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * A list item and the text before its content: any indentation, any blockquote
 * markers, the bullet or number, its space, and a task-list checkbox when the
 * item opens with one. Indented code is excluded before this runs. The checkbox
 * stays first, so the renderer still reads the item as a task.
 */
const LIST_ITEM = /^([ \t]*(?:>[ \t]?)*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?/;

/** Four spaces or a tab after a blank line opens an indented code block. */
const INDENTED_CODE = /^([ \t]{4}|[ \t]*\t)/;

/**
 * A thematic break: three or more of one bullet character, spaced or not. Its
 * first three characters match a list item, so it must be recognized before the
 * marker, or the mark turns the rule into a bullet.
 */
const THEMATIC_BREAK = /^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

type Fence = { readonly mark: string; readonly length: number };

/** The fence that closes `open`, or `null` for any other line. */
function closingFence(open: Fence, content: string): Fence | null {
  const found = FENCE_CLOSE.exec(content);
  const run = found?.[1];
  if (run === undefined) {
    return null;
  }
  return run.startsWith(open.mark) ? { mark: open.mark, length: run.length } : null;
}

function withStartEdge(line: string): string {
  if (THEMATIC_BREAK.test(line.replace(BLOCKQUOTE, ''))) {
    return line;
  }
  const item = LIST_ITEM.exec(line);
  if (item === null) {
    return line;
  }
  const prefix = item[0];
  const content = line.slice(prefix.length);
  // A marker on its own line opens nothing to align.
  return content.trim() === '' ? line : `${prefix}${RIGHT_TO_LEFT_MARK}${content}`;
}

/**
 * The same markdown with the interface start edge named inside every list item.
 * Fenced and indented code keep their text exactly: a list-shaped line there is
 * code, not a list.
 */
export function rtlListItems(markdown: string): string {
  let open: Fence | null = null;
  let indentedCode = false;
  let afterBlankLine = true;
  return markdown
    .split('\n')
    .map(line => {
      const content = line.replace(BLOCKQUOTE, '');
      if (open !== null) {
        const close = closingFence(open, content);
        if (close !== null && close.length >= open.length) {
          open = null;
        }
        afterBlankLine = false;
        return line;
      }
      if (indentedCode) {
        if (line.trim() === '' || INDENTED_CODE.test(line)) {
          return line;
        }
        indentedCode = false;
      }
      const fence = FENCE_OPEN.exec(content)?.[1];
      if (fence !== undefined) {
        open = { mark: fence, length: fence.length };
        afterBlankLine = false;
        return line;
      }
      if (afterBlankLine && INDENTED_CODE.test(line)) {
        indentedCode = true;
        afterBlankLine = false;
        return line;
      }
      afterBlankLine = line.trim() === '';
      return withStartEdge(line);
    })
    .join('\n');
}
