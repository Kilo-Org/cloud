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

const REMOVED_TAG_NAMES = REMOVED_HTML_TAGS.join('|');
const REMOVED_CONTAINER_RE = new RegExp(
  `<(${REMOVED_TAG_NAMES})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi'
);
const REMOVED_TAG_RE = new RegExp(`<\\/?(?:${REMOVED_TAG_NAMES})\\b[^>]*>`, 'gi');
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
// A container emptied by the removals above draws no ink either: the HTML
// engine renders `<div></div>` as an empty box. Stripping emptied containers
// keeps the predicate aligned with what the renderer actually paints. Only the
// innermost emptied element matches in one pass, so `n` levels of nesting
// collapse over `n` passes — hence the bound below.
const EMPTY_CONTAINER_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>\s*<\/\1\s*>/g;

/**
 * Passes the removals may take over one value.
 *
 * Each pass is four whole-value replaces, so an unbounded fixpoint made the cost
 * of one value grow with its nesting depth times its length — and this predicate
 * is asked again for every streamed publish and every transcript rebuild. Seven
 * levels of all-empty nesting still collapse exactly as before; past the bound
 * the value is reported as having visible content, so the part renders (an empty
 * bubble in the pathological case) instead of being skipped. Nothing that
 * renders is ever hidden by the bound.
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
  // allocating replaces keeps a long streamed part O(1) per publish here.
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
    const next = sanitized
      .replace(HTML_COMMENT_RE, '')
      .replace(REMOVED_CONTAINER_RE, '')
      .replace(REMOVED_TAG_RE, '')
      .replace(EMPTY_CONTAINER_RE, '');
    if (next === sanitized) {
      return next.trim() === '';
    }
    sanitized = next;
  }
  return false;
}

/** For tests: drop the memoized answers so a suite starts cold. */
export function clearHtmlEmptinessCacheForTests(): void {
  emptinessCache.clear();
}
