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
  'picture',
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

/** True when the HTML renderer removes every non-whitespace character. */
export function htmlSanitizesToEmpty(value: string): boolean {
  let sanitized = value;
  for (;;) {
    const next = sanitized
      .replace(HTML_COMMENT_RE, '')
      .replace(REMOVED_CONTAINER_RE, '')
      .replace(REMOVED_TAG_RE, '');
    if (next === sanitized) {
      return next.trim() === '';
    }
    sanitized = next;
  }
}
