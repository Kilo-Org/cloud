/**
 * Slack message formatting helpers for values that come from outside the server.
 *
 * Slack renders message `text` and `mrkdwn` blocks with its own markup, so a
 * value interpolated into one must be escaped first: otherwise the value's own
 * `<`, `>` and `&` characters are read as Slack markup, and a backtick can end
 * the code span that holds it and return the rest of the line to markup.
 *
 * Plain-text block content does not need this: Slack does not parse `plain_text`
 * as markup. Use these helpers for `text` and `mrkdwn` fields only.
 */

/** Escapes the three characters Slack treats as markup delimiters. */
export function escapeSlackText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Escapes a value used inside a single line, including inside a backtick code
 * span: escapes markup delimiters, replaces backticks so the value stays inside
 * its span, and collapses line breaks so the value stays on its own line.
 */
export function escapeSlackLabel(value: string): string {
  return escapeSlackText(value)
    .replaceAll('`', "'")
    .replace(/\r\n|\r|\n/g, ' ');
}
