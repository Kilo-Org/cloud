import { CharacterBoundedCache } from './character-bounded-cache';

export const REMOVED_HTML_TAGS = [
  'script',
  'style',
  'link',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'audio',
  'video',
  'source',
  'track',
  'form',
  'input',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'label',
  'fieldset',
  'legend',
  'datalist',
  'output',
  'meter',
  'progress',
  'svg',
  'canvas',
  'base',
  'head',
  'meta',
  'title',
  'template',
  'noscript',
] as const;

const REMOVED_TAG_SET: ReadonlySet<string> = new Set(REMOVED_HTML_TAGS);
const REMOVED_TAG_NAMES = REMOVED_HTML_TAGS.join('|');
// The end tag of a removed container, or the start tag of any removed element
// (a void element such as `input` included).
const REMOVED_TAG_RE = new RegExp(`<\\/?(?:${REMOVED_TAG_NAMES})\\b[^>]*>`, 'gi');
// A container emptied by the removals above draws no ink either: the HTML
// engine renders `<div></div>` as an empty box. Stripping emptied containers
// keeps the predicate aligned with what the renderer actually paints. Only the
// innermost emptied element matches in one pass, so `n` levels of nesting
// collapse over `n` passes — hence the bound below.
const EMPTY_CONTAINER_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>\s*<\/\1\s*>/g;

/** A tag name run, matching the `\b` the old `<(?:names)\b` alternation implied. */
const TAG_NAME_RUN_RE = /[a-zA-Z_][a-zA-Z0-9_]*/y;
/** The `\s*>` tail of an end tag. */
const END_TAG_TAIL_RE = /\s*>/y;

/**
 * Passes the removals may take over one value.
 *
 * Each pass is two whole-value replaces beside the two linear scans, so an
 * unbounded fixpoint made the cost of one value grow with its nesting depth
 * times its length — and this predicate is asked again for every streamed
 * publish and every transcript rebuild. Seven levels of all-empty nesting still
 * collapse exactly as before; past the bound the value is reported as having
 * visible content, so the part renders (an empty bubble in the pathological
 * case) instead of being skipped. Nothing that renders is ever hidden by the
 * bound.
 */
const HTML_SANITIZE_MAX_PASSES = 8;

// Callers ask about the same part value on every transcript rebuild and on every
// remount, and the answer is pure, so it is memoized. The key is the value, so
// the budget is a bound on the source text a warm cache pins.
const HTML_EMPTINESS_CACHE_CHARACTERS = 1_000_000;
const emptinessCache = new CharacterBoundedCache<boolean>(HTML_EMPTINESS_CACHE_CHARACTERS);

/** True when the HTML renderer removes every non-whitespace character. */
export function htmlSanitizesToEmpty(value: string): boolean {
  // Fast path for the streamed-text case: with no '<' there is no HTML to
  // remove, so the sanitized text is the input itself. Skipping the four
  // allocating removes keeps a long streamed part O(1) per publish here.
  if (!value.includes('<')) {
    return !/\S/.test(value);
  }
  const cached = emptinessCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const sanitizesToEmpty = sanitizesToEmptyAfterRemovals(value);
  emptinessCache.set(value, sanitizesToEmpty);
  return sanitizesToEmpty;
}

/** The removals, iterated while they still change the value, up to the bound. */
function sanitizesToEmptyAfterRemovals(value: string): boolean {
  let sanitized = value;
  for (let pass = 0; pass < HTML_SANITIZE_MAX_PASSES; pass += 1) {
    const next = removeRemovedContainers(removeHtmlComments(sanitized))
      .replace(REMOVED_TAG_RE, '')
      .replace(EMPTY_CONTAINER_RE, '');
    if (next === sanitized) {
      return next.trim() === '';
    }
    sanitized = next;
  }
  return false;
}

/**
 * Drop every removed tag name that starts at `at`, else `undefined`. The name
 * compare is case-insensitive, as the old alternation's `i` flag was. A tag
 * name is an ASCII token, not display text, and the case fold must not consult
 * the device locale: `INPUT` lowercases to `ınput` under `tr`, which would stop
 * a removed tag matching on that device. The same locale-independent fold is
 * what `markdown-html.tsx` and `markdown-html-tree.ts` use for HTML tag names,
 * and the case guard lists this file for that reason.
 */
function removedTagNameAt(value: string, at: number): string | undefined {
  TAG_NAME_RUN_RE.lastIndex = at;
  const match = TAG_NAME_RUN_RE.exec(value);
  if (match === null) {
    return undefined;
  }
  const name = match[0].toLowerCase();
  return REMOVED_TAG_SET.has(name) ? name : undefined;
}

/** The end of an end tag's `\s*>` tail at `at`, or `-1` when there is none. */
function endTagTailAt(value: string, at: number): number {
  END_TAG_TAIL_RE.lastIndex = at;
  return END_TAG_TAIL_RE.exec(value) === null ? -1 : END_TAG_TAIL_RE.lastIndex;
}

/**
 * One index per removed tag name: the ascending offsets of every end tag of
 * that name (`</name\s*>`). One forward scan over the value builds the whole
 * index, so a start tag looks its closer up instead of walking the tail.
 */
function indexRemovedEndTags(value: string): Map<string, number[]> {
  const endTags = new Map<string, number[]>();
  let at = 0;
  while (at < value.length) {
    const slash = value.indexOf('</', at);
    if (slash === -1) {
      break;
    }
    const name = removedTagNameAt(value, slash + 2);
    if (name !== undefined && endTagTailAt(value, slash + 2 + name.length) !== -1) {
      const offsets = endTags.get(name);
      if (offsets === undefined) {
        endTags.set(name, [slash]);
      } else {
        offsets.push(slash);
      }
    }
    at = slash + 2;
  }
  return endTags;
}

/** The first offset in an ascending list that is at or after `from`, if any. */
function endTagAtOrAfter(offsets: readonly number[], from: number): number | undefined {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? 0) < from) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low < offsets.length ? offsets[low] : undefined;
}

/**
 * Remove a removed element and everything up to its own end tag: the `<name>`
 * start tag, the content, and the `</name>` closer. A start tag whose closer
 * never appears stays, so a value that names a removed element without closing
 * it is rendered as text, exactly as the pattern this replaces answered.
 *
 * The offsets come from {@link indexRemovedEndTags}, so the cost is one pass to
 * build the index plus one pass over the start tags: a void removed element
 * (`<input>`, `<source>`, `<link>`) that can never close costs its own length
 * instead of a scan to the end of the value, which is what a streamed publish
 * with many of them used to pay on every frame.
 *
 * Known divergence from the renderer, left as it was: `<input>hello</input>`
 * answers "empty" here because the container removal takes `hello` with the
 * element, while the HTML renderer draws it. Changing that answer is a
 * separate fix; this function keeps the predicate's answers unchanged.
 */
function removeRemovedContainers(value: string): string {
  const endTags = indexRemovedEndTags(value);
  // Every start tag ends at a `>` at or after its name, so one reverse lookup
  // answers "can any start tag at or after this point complete?". Without it a
  // value that never completes a start tag pays the tail walk once per tag.
  const lastTagEnd = value.lastIndexOf('>');
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
      const tagEnd = lastTagEnd < nameEnd ? -1 : value.indexOf('>', nameEnd);
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

/** For tests: drop the memoized answers so a suite starts cold. */
export function clearHtmlEmptinessCacheForTests(): void {
  emptinessCache.clear();
}
