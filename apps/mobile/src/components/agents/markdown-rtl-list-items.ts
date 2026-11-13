/**
 * The Android markdown renderer resolves each paragraph's direction from its
 * first strong character and draws a list item's marker and indent on that
 * paragraph's leading edge. A list style carries no alignment of its own, so a
 * reply in the interface's script aligns to the start edge while its bullets
 * stay on the left. Naming the start edge inside each item's own text moves the
 * marker, the indent and the wrapped lines to the same edge as the heading and
 * every other paragraph of the turn.
 *
 * The mark is a right-to-left mark (U+200F), a strong character with no width,
 * so it names the interface start edge for the paragraph without drawing or
 * speaking anything. The item's own words then sit inside a first-strong
 * isolate, which keeps them in their own direction: a run of Latin words still
 * ends its sentence with the full stop at the end, and Arabic or Hebrew words
 * still read right to left. The mark stays outside the isolate because the bidi
 * algorithm skips text inside an isolate while it resolves the paragraph's
 * direction.
 */
const RIGHT_TO_LEFT_MARK = '\u200F';

/** Opens the isolate that lets the item's own text keep its own direction. */
const FIRST_STRONG_ISOLATE = '\u2068';

/** Closes that isolate at the end of the item's own text. */
const POP_DIRECTIONAL_ISOLATE = '\u2069';

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

/**
 * The item with the start edge named and its text opened as an isolate, or
 * `null` for a line that is not an item with content. The closer is set by the
 * caller, at the end of the item's text.
 */
function withStartEdge(line: string): string | null {
  if (THEMATIC_BREAK.test(line.replace(BLOCKQUOTE, ''))) {
    return null;
  }
  const item = LIST_ITEM.exec(line);
  if (item === null) {
    return null;
  }
  const prefix = item[0];
  const content = line.slice(prefix.length);
  // A marker on its own line opens nothing to align.
  if (content.trim() === '') {
    return null;
  }
  return `${prefix}${RIGHT_TO_LEFT_MARK}${FIRST_STRONG_ISOLATE}${content}`;
}

/**
 * Whether `line` carries text that belongs to the item above it: not blank, not
 * a blockquote, fence or rule, and not another item's marker.
 */
function continuesItem(line: string): boolean {
  if (line.trim() === '') {
    return false;
  }
  if (BLOCKQUOTE.test(line) || FENCE_OPEN.test(line) || THEMATIC_BREAK.test(line)) {
    return false;
  }
  return LIST_ITEM.exec(line) === null;
}

/**
 * The same markdown with the interface start edge named inside every list item
 * and the item's own text isolated so it keeps its own direction. The closer
 * sits at the end of the item's text, across its lazy continuation lines.
 * Fenced and indented code keep their text exactly: a list-shaped line there is
 * code, not a list.
 */
export function rtlListItems(markdown: string): string {
  const lines: string[] = [];
  let open: Fence | null = null;
  let indentedCode = false;
  let afterBlankLine = true;
  // The line whose isolate is still open; a closer lands at the end of it.
  let pending: number | null = null;

  const closeIsolate = (): void => {
    if (pending === null) {
      return;
    }
    const last = lines[pending];
    if (last !== undefined) {
      lines[pending] = `${last}${POP_DIRECTIONAL_ISOLATE}`;
    }
    pending = null;
  };

  /**
   * Adds one source line: an item line opens an isolate, a continuation line
   * keeps it open, and any other line closes it. Code lines pass through.
   */
  const emit = (line: string): void => {
    if (pending !== null) {
      if (continuesItem(line)) {
        afterBlankLine = false;
        pending = lines.length;
        lines.push(line);
        return;
      }
      closeIsolate();
    }
    const content = line.replace(BLOCKQUOTE, '');
    if (open !== null) {
      const close = closingFence(open, content);
      if (close !== null && close.length >= open.length) {
        open = null;
      }
      afterBlankLine = false;
      lines.push(line);
      return;
    }
    if (indentedCode) {
      if (line.trim() === '' || INDENTED_CODE.test(line)) {
        lines.push(line);
        return;
      }
      indentedCode = false;
    }
    const fence = FENCE_OPEN.exec(content)?.[1];
    if (fence !== undefined) {
      open = { mark: fence, length: fence.length };
      afterBlankLine = false;
      lines.push(line);
      return;
    }
    if (afterBlankLine && INDENTED_CODE.test(line)) {
      indentedCode = true;
      afterBlankLine = false;
      lines.push(line);
      return;
    }
    afterBlankLine = line.trim() === '';
    const rewritten = withStartEdge(line);
    if (rewritten === null) {
      lines.push(line);
      return;
    }
    pending = lines.length;
    lines.push(rewritten);
  };

  for (const line of markdown.split('\n')) {
    emit(line);
  }
  closeIsolate();
  return lines.join('\n');
}
