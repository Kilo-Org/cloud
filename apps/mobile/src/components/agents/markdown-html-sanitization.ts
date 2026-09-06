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
// (iterated to a fixpoint so nesting collapses outermost-last) keeps the
// predicate aligned with what the renderer actually paints.
const EMPTY_CONTAINER_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>\s*<\/\1\s*>/g;

/** True when the HTML renderer removes every non-whitespace character. */
export function htmlSanitizesToEmpty(value: string): boolean {
  let sanitized = value;
  for (;;) {
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
}
