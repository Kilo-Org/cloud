import {
  CONTAINER_NAME_RUN_RE,
  type EmptyContainerCloser,
  emptyContainerCloserAt,
  emptyContainerEnd,
  endTagAtOrAfter,
  endTagTailAt,
  indexRemovedEndTags,
  removedTagNameAt,
} from './markdown-html-sanitization';

/**
 * Passes the removals may take over one value.
 *
 * Each pass is a removed-container scan, a comment scan, a removed-tag scan and
 * an empty-container scan, so an unbounded fixpoint made the cost of one value
 * grow with its nesting depth times its length — and the emptiness predicate is
 * asked again for every streamed publish and every transcript rebuild. Seven
 * levels of all-empty nesting still collapse exactly as before; past the bound
 * the value is reported as having visible content, so the part renders (an
 * empty bubble in the pathological case) instead of being skipped. Nothing that
 * renders is ever hidden by the bound.
 */
const HTML_SANITIZE_MAX_PASSES = 8;

/** The outcome of the pass loop: the string it settled on, or the bound it hit. */
type HtmlSanitizeRun =
  | {
      /** The removals reached a fixpoint, so `sanitized` is their fixed point. */
      readonly outcome: 'converged';
      readonly passes: number;
      readonly sanitized: string;
    }
  | {
      /** The bound ran out while the value still changed; `sanitized` is not final. */
      readonly outcome: 'exhausted';
      readonly passes: number;
      readonly sanitized: string;
    };

/**
 * The removals, iterated while they still change the value, up to the bound.
 * Every step is a linear scan, so one pass costs time proportional to the
 * value's length.
 */
export function sanitizeHtmlRemovals(value: string): HtmlSanitizeRun {
  let sanitized = value;
  for (let pass = 0; pass < HTML_SANITIZE_MAX_PASSES; pass += 1) {
    const next = removeEmptyContainers(
      removeRemovedTags(removeRemovedContainers(removeHtmlComments(sanitized)))
    );
    if (next === sanitized) {
      return { outcome: 'converged', passes: pass + 1, sanitized };
    }
    sanitized = next;
  }
  return { outcome: 'exhausted', passes: HTML_SANITIZE_MAX_PASSES, sanitized };
}

/**
 * Remove a removed element and everything up to its own end tag: the `<name>`
 * start tag, the content, and the `</name>` closer. A start tag whose closer
 * never appears stays, so a value that names a removed element without closing
 * it is rendered as text, exactly as the pattern this replaces answered.
 *
 * The offsets come from {@link indexRemovedEndTags}, so the cost is one pass to
 * build the index plus one pass over the start tags. The `>` that terminates a
 * start tag is found through one cursor that only moves forward: the search
 * offset grows with every start tag, so a cached offset that is still at or
 * after that point is reused and each region of the value is read once. A
 * streamed publish whose start tags never complete in one pass — `<input`
 * repeated, with no `>` until much later — therefore pays one walk to the end
 * instead of one per tag.
 *
 * Known divergence from the renderer, left as it was: `<input>hello</input>`
 * answers "empty" here because the container removal takes `hello` with the
 * element, while the HTML renderer draws it. Changing that answer is a
 * separate fix; this function keeps the predicate's answers unchanged.
 */
function removeRemovedContainers(value: string): string {
  const endTags = indexRemovedEndTags(value);
  // The first `>` at or after the last start tag's name end, or -1. A name end
  // is always past the start, so the first candidate searches once.
  let nextTagEnd = -1;
  let kept = 0;
  let result = '';
  let at = 0;
  while (at < value.length) {
    const start = value.indexOf('<', at);
    if (start === -1) {
      break;
    }
    const name = removedTagNameAt(value, start + 1);
    let closerEnd = -1;
    if (name !== undefined) {
      const nameEnd = start + 1 + name.length;
      // The cursor is -1 until the first search, and a search that finds nothing
      // ends the scan, so a value at or after this name end means "not yet".
      if (nextTagEnd < nameEnd) {
        nextTagEnd = value.indexOf('>', nameEnd);
      }
      const tagEnd = nextTagEnd;
      if (tagEnd === -1) {
        // No `>` at or after this point means no start tag later in the value
        // can complete either, so one truncated tag ends the scan.
        break;
      }
      const offsets = endTags.get(name);
      const closer = offsets === undefined ? undefined : endTagAtOrAfter(offsets, tagEnd + 1);
      if (closer !== undefined) {
        closerEnd = endTagTailAt(value, closer + 2 + name.length);
      }
    }
    if (closerEnd === -1) {
      at = start + 1;
    } else {
      // The start tag, its content and its closer form one removed element.
      result += value.slice(kept, start);
      kept = closerEnd;
      at = closerEnd;
    }
  }
  return result + value.slice(kept);
}

/**
 * Drop every `<!-- ... -->` comment. An unterminated `<!--` matches nothing
 * and stays, as the pattern it replaces answered; that case is recognised once
 * and ends the scan instead of walking to the end of the value per occurrence.
 */
function removeHtmlComments(value: string): string {
  let kept = 0;
  let result = '';
  let at = 0;
  while (at < value.length) {
    const open = value.indexOf('<!--', at);
    if (open === -1) {
      break;
    }
    const close = value.indexOf('-->', open + 4);
    if (close === -1) {
      break;
    }
    result += value.slice(kept, open);
    kept = close + 3;
    at = kept;
  }
  return result + value.slice(kept);
}

/**
 * Drop every removed element's end tag and every removed element's start tag,
 * so `<input>`, `</source >` and `<script src="x">` all go while their content
 * stays. The match set is the one the previous whole-value pattern had: `<`, an
 * optional `/`, a removed name (case-insensitive) terminated by a `\b`, any run
 * of non-`>` characters, then a `>`.
 *
 * One forward scan replaces the pattern's backtracking over `[^>]*`: when no
 * `>` follows a candidate's name, no later candidate can complete either, so
 * the scan ends and the rest is kept verbatim. That is the shape a streamed
 * frame produces mid-tag. No `>` offset is cached: every match consumes through
 * its own `>`, so the next candidate's name end is always past it and a fresh
 * search is the only one that can answer. Each target `>` is found from the
 * match before it, so the regions the searches read do not overlap and the scan
 * stays linear; the `break` is what keeps a `>`-free tail from being walked per
 * candidate.
 */
function removeRemovedTags(value: string): string {
  let kept = 0;
  let result = '';
  let at = 0;
  while (at < value.length) {
    const start = value.indexOf('<', at);
    if (start === -1) {
      break;
    }
    const isEndTag = value.startsWith('/', start + 1);
    const name = removedTagNameAt(value, isEndTag ? start + 2 : start + 1);
    if (name === undefined) {
      at = start + 1;
    } else {
      const nameEnd = start + name.length + (isEndTag ? 2 : 1);
      const tagEnd = value.indexOf('>', nameEnd);
      if (tagEnd === -1) {
        // No `>` at or after this point means no later candidate completes
        // either; the rest of the value stays as it is.
        break;
      }
      result += value.slice(kept, start);
      kept = tagEnd + 1;
      at = kept;
    }
  }
  return result + value.slice(kept);
}

/**
 * Drop every container that holds only whitespace: the HTML engine renders
 * `<div>   </div>` as an empty box, so stripping it keeps the predicate aligned
 * with what the renderer paints. The match set is the one the previous
 * whole-value pattern had: `<`, a `[a-zA-Z][a-zA-Z0-9-]*` name at a `\b`, any
 * run of non-`>` characters, `>`, `\s*`, `</`, the same name with the exact
 * case, `\s*`, `>`.
 *
 * The name group of that pattern backtracks: at a start whose full run does not
 * equal the closer's name, a shorter prefix that still ends at a `\b` may. Every
 * candidate that ends at the same open tag `>` also shares the same closer: the
 * whitespace run, `</` and closer name after that `>` do not depend on the open
 * tag's name, which is the only thing that varies between those candidates. So
 * {@link emptyContainerCloserAt} runs once per `>` and each candidate pays only
 * its own name-length prefix compare. The `>` search itself runs on one
 * monotonic cursor, so a value with no `>` costs one walk to its end rather than
 * one per candidate `<`.
 */
function removeEmptyContainers(value: string): string {
  let kept = 0;
  let result = '';
  // The `>` that ends the current open tag, and the closer scan after it; both
  // are unset until the first candidate searches. The cursor only moves forward,
  // so an offset still at or after a later candidate's name end is reused with
  // its scan, and each region of the value is read once.
  let openEndCursor = -1;
  let closer: EmptyContainerCloser | undefined = undefined;
  let at = 0;
  while (at < value.length) {
    const start = value.indexOf('<', at);
    if (start === -1) {
      break;
    }
    const nameAt = start + 1;
    CONTAINER_NAME_RUN_RE.lastIndex = nameAt;
    const run = CONTAINER_NAME_RUN_RE.exec(value);
    let closerEnd = -1;
    if (run !== null) {
      if (openEndCursor < nameAt) {
        openEndCursor = value.indexOf('>', nameAt);
        closer =
          openEndCursor === -1 ? undefined : emptyContainerCloserAt(value, openEndCursor + 1);
      }
      if (openEndCursor === -1) {
        // No `>` at or after this name: no open tag later in the value can
        // complete either, so the rest stays as it is.
        break;
      }
      closerEnd = emptyContainerEnd(value, nameAt, closer);
    }
    if (closerEnd === -1) {
      at = start + 1;
    } else {
      result += value.slice(kept, start);
      kept = closerEnd;
      at = closerEnd;
    }
  }
  return result + value.slice(kept);
}

/** For tests: the number of passes the removals ran over `value`. */
export function htmlRemovalPassesForTests(value: string): number {
  return sanitizeHtmlRemovals(value).passes;
}

/**
 * For tests: the string the removal pass loop last produced for `value`, or
 * `undefined` when the bound ran out before the removals reached a fixpoint.
 * The distinct `undefined` keeps "settled on empty" apart from "still changing".
 */
export function htmlSanitizedForTests(value: string): string | undefined {
  const run = sanitizeHtmlRemovals(value);
  return run.outcome === 'converged' ? run.sanitized : undefined;
}
