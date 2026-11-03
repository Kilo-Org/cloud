/**
 * A fenced code block's source, taken out of a markdown run.
 */
type MarkdownCodeRun = {
  type: 'code';
  code: string;
  /** The first token of the fence's info string, as written; null when empty. */
  language: string | null;
  /** False while a streaming append has not delivered the closing fence yet. */
  closed: boolean;
};

type MarkdownTextRun = { type: 'text'; raw: string };

export type MarkdownRun = MarkdownCodeRun | MarkdownTextRun;

/** A source line, and the offset just past its newline (or the end of the run). */
type MarkdownLine = { text: string; next: number };

type OpeningFence = { fenceChar: string; fenceLength: number; info: string };

/** Three or more backticks or tildes at column 0, then the info string. */
const OPENING_FENCE = /^(`{3,}|~{3,})(.*)$/;
/** The same run of fence characters alone on a line, indented by up to three spaces. */
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function openingFence(line: string): OpeningFence | null {
  const [, fence = '', info = ''] = OPENING_FENCE.exec(line) ?? [];
  if (fence.length < 3) {
    return null;
  }
  // CommonMark: a backtick fence's info string cannot itself contain a
  // backtick, which keeps a line like ``` `x` ``` an inline code span.
  if (fence.startsWith('`') && info.includes('`')) {
    return null;
  }
  return {
    fenceChar: fence.startsWith('`') ? '`' : '~',
    fenceLength: fence.length,
    info: info.trim(),
  };
}

/** A closing fence repeats the opening character at least as many times. */
function closesFence(line: string, fenceChar: string, fenceLength: number): boolean {
  const [, fence = ''] = CLOSING_FENCE.exec(line) ?? [];
  return fence.length >= fenceLength && fence.startsWith(fenceChar);
}

function languageOf(info: string): string | null {
  const [token = ''] = info.split(/\s+/);
  return token.length === 0 ? null : token;
}

/**
 * Split a markdown run into its text runs and its top-level fenced code blocks.
 *
 * The markdown renderer draws a fence as a horizontally scrolling,
 * never-wrapping pane, and that pane's pan gesture never reaches it inside the
 * conversation list (see `mono-scroll-block.tsx`), so a long line is clipped
 * with no way to read it. Taking the fence out of the run lets the caller draw
 * it with the wrapping `CodeBlock` instead.
 *
 * Only a fence starting at column 0 is taken: that is what makes it a
 * block-level fence rather than content of a list item, a blockquote (`> ````)
 * or an indented code block. A fence indented into any of those stays in the
 * text run and keeps the renderer's own behavior.
 *
 * An unclosed fence runs to the end of the run and reports `closed: false`, so a
 * streamed append keeps drawing the growing block until its closing fence
 * arrives instead of flashing its source as a paragraph.
 */
export function splitMarkdownFences(raw: string): MarkdownRun[] {
  const runs: MarkdownRun[] = [];
  let textStart = 0;
  let cursor = 0;

  const pushText = (end: number) => {
    if (end > textStart) {
      runs.push({ type: 'text', raw: raw.slice(textStart, end) });
    }
  };

  const readLine = (): MarkdownLine => {
    const newline = raw.indexOf('\n', cursor);
    const end = newline === -1 ? raw.length : newline;
    // A CRLF value keeps its `\r` on every line; drop it so a fence opens and
    // closes on the same text the renderer would see, and so the code has none.
    const text = raw.slice(cursor, end).replace(/\r$/, '');
    const line = { text, next: newline === -1 ? raw.length : newline + 1 };
    cursor = line.next;
    return line;
  };

  while (cursor < raw.length) {
    const lineStart = cursor;
    const opening = openingFence(readLine().text);
    if (opening) {
      const codeLines: string[] = [];
      let closed = false;
      let afterFence = raw.length;
      while (cursor < raw.length) {
        const inner = readLine();
        if (closesFence(inner.text, opening.fenceChar, opening.fenceLength)) {
          closed = true;
          afterFence = inner.next;
          cursor = afterFence;
          break;
        }
        codeLines.push(inner.text);
      }

      pushText(lineStart);
      runs.push({
        type: 'code',
        code: codeLines.join('\n'),
        language: languageOf(opening.info),
        closed,
      });
      textStart = afterFence;
      cursor = afterFence;
    }
  }

  pushText(raw.length);
  return runs;
}
