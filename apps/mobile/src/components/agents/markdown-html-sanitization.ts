import { CharacterBoundedCache } from './character-bounded-cache';
import { sanitizeHtmlRemovals } from './markdown-html-removal-run';

export { htmlRemovalPassesForTests, htmlSanitizedForTests } from './markdown-html-removal-run';

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

/** A tag name run, matching the `\b` the old `<(?:names)\b` alternation implied. */
const TAG_NAME_RUN_RE = /[a-zA-Z_][a-zA-Z0-9_]*/y;
/** The `\s*>` tail of an end tag. */
const END_TAG_TAIL_RE = /\s*>/y;
/** A container name run: the `[a-zA-Z][a-zA-Z0-9-]*` of an emptied element. */
export const CONTAINER_NAME_RUN_RE = /[a-zA-Z][a-zA-Z0-9-]*/y;
/** The whitespace run inside an emptied container's `<name …>…</name>` tail. */
const WHITESPACE_RUN_RE = /\s*/y;

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
  const run = sanitizeHtmlRemovals(value);
  // A value that still changes on its last allowed pass is reported as visible,
  // as it always was: the loop never proved the removals reached a fixpoint.
  const sanitizesToEmpty = run.outcome === 'converged' && run.sanitized.trim() === '';
  emptinessCache.set(value, sanitizesToEmpty);
  return sanitizesToEmpty;
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
export function removedTagNameAt(value: string, at: number): string | undefined {
  TAG_NAME_RUN_RE.lastIndex = at;
  const match = TAG_NAME_RUN_RE.exec(value);
  if (match === null) {
    return undefined;
  }
  const name = match[0].toLowerCase();
  return REMOVED_TAG_SET.has(name) ? name : undefined;
}

/** The end of an end tag's `\s*>` tail at `at`, or `-1` when there is none. */
export function endTagTailAt(value: string, at: number): number {
  END_TAG_TAIL_RE.lastIndex = at;
  return END_TAG_TAIL_RE.exec(value) === null ? -1 : END_TAG_TAIL_RE.lastIndex;
}

/**
 * One index per removed tag name: the ascending offsets of every end tag of
 * that name (`</name\s*>`). One forward scan over the value builds the whole
 * index, so a start tag looks its closer up instead of walking the tail.
 */
export function indexRemovedEndTags(value: string): Map<string, number[]> {
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
export function endTagAtOrAfter(offsets: readonly number[], from: number): number | undefined {
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
 * The closer that follows one open tag: the whitespace run after its `>`, then
 * `</`, that closer's name run, and the `\s*>` tail after it. Every field
 * depends only on the open tag's `>`, never on the open tag's name.
 */
export type EmptyContainerCloser = {
  /** Where the closer's name run starts, just past its `</`. */
  readonly nameAt: number;
  /** The length of the closer's name run. */
  readonly runLength: number;
  /** The end of the `\s*>` tail after that whole run, or `-1` for none. */
  readonly tailEnd: number;
};

/**
 * The closer at or after `tailAt`, which is just past an open tag's `>`, or
 * `undefined` when no `</name …>` follows it. One call answers every candidate
 * start tag that ends at that `>`.
 */
export function emptyContainerCloserAt(
  value: string,
  tailAt: number
): EmptyContainerCloser | undefined {
  WHITESPACE_RUN_RE.lastIndex = tailAt;
  WHITESPACE_RUN_RE.exec(value);
  const closerAt = WHITESPACE_RUN_RE.lastIndex;
  if (!value.startsWith('</', closerAt)) {
    return undefined;
  }
  const nameAt = closerAt + 2;
  CONTAINER_NAME_RUN_RE.lastIndex = nameAt;
  const run = CONTAINER_NAME_RUN_RE.exec(value);
  if (run === null) {
    return undefined;
  }
  const runLength = run[0].length;
  return { nameAt, runLength, tailEnd: endTagTailAt(value, nameAt + runLength) };
}

/**
 * The end of a `</name\s*>` closer for the open tag whose name run starts at
 * `nameAt`, or `-1`. `closer` is the scan of the text after that open tag's `>`,
 * which no candidate can change.
 *
 * The pattern's name group backtracks, so a prefix of the run that ends at a
 * `\b` matches too. Such a prefix can only reach the closer's own name run when
 * it is that whole run: a shorter prefix stops inside the run, at a name
 * character `\s*>` cannot match, so the tail is only reachable there and the
 * cached `tailEnd` answers every prefix length.
 */
export function emptyContainerEnd(
  value: string,
  nameAt: number,
  closer: EmptyContainerCloser | undefined
): number {
  if (closer === undefined) {
    return -1;
  }
  CONTAINER_NAME_RUN_RE.lastIndex = nameAt;
  const openRun = CONTAINER_NAME_RUN_RE.exec(value);
  if (openRun === null) {
    return -1;
  }
  // The longest name the backreference can satisfy is the common prefix of the
  // run and the closer's text. The open run bounds it: past that run the open
  // tag's own `>` cannot equal a name character.
  const openRunLength = openRun[0].length;
  let prefix = 0;
  while (
    prefix < openRunLength &&
    value.codePointAt(nameAt + prefix) === value.codePointAt(closer.nameAt + prefix)
  ) {
    prefix += 1;
  }
  if (prefix < closer.runLength) {
    return -1;
  }
  const length = closer.runLength;
  const before = isWordCode(value.codePointAt(nameAt + length - 1));
  const after = isWordCode(value.codePointAt(nameAt + length));
  return before === after ? -1 : closer.tailEnd;
}

/** True for the ASCII characters a `\b` treats as word characters. */
function isWordCode(code: number | undefined): boolean {
  if (code === undefined) {
    return false;
  }
  return (
    code === 95 ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

/** For tests: drop the memoized answers so a suite starts cold. */
export function clearHtmlEmptinessCacheForTests(): void {
  emptinessCache.clear();
}
