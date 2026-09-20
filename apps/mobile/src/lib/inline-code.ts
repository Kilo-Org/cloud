/** One run of body copy: plain text, or a `backtick` span the caller renders as code. */
export type InlineCodeSegment = {
  value: string;
  code: boolean;
};

const BACKTICK = '`';

/**
 * Splits catalog copy into plain text and inline-code runs.
 *
 * The remote-CLI help strings name commands in markdown backticks (`kilo
 * remote`, `/remote`), and every catalog keeps that marker, so the app has to
 * render it as inline code instead of printing the tick marks. Only paired
 * backticks become code: a lone marker, and an empty pair, stay in the text
 * verbatim, so a stray mark can never swallow the rest of the line.
 *
 * The copy is short body text, so the scan is a plain left-to-right walk
 * rather than a markdown parse — the only markup these strings carry is the
 * code span.
 */
export function splitInlineCode(value: string): InlineCodeSegment[] {
  const segments: InlineCodeSegment[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const open = value.indexOf(BACKTICK, cursor);
    if (open === -1) {
      segments.push({ value: value.slice(cursor), code: false });
      break;
    }
    const close = value.indexOf(BACKTICK, open + 1);
    if (close === -1) {
      // An unpaired marker is copy, not markup.
      segments.push({ value: value.slice(cursor), code: false });
      break;
    }
    if (open > cursor) {
      segments.push({ value: value.slice(cursor, open), code: false });
    }
    if (close === open + 1) {
      // An empty span has no run to style: keep both ticks as literal copy.
      segments.push({ value: value.slice(open, close + 1), code: false });
    } else {
      segments.push({ value: value.slice(open + 1, close), code: true });
    }
    cursor = close + 1;
  }

  return segments;
}
