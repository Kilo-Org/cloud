/**
 * Slack message formatting helpers for values that come from outside the server.
 *
 * Slack renders message `text` and `mrkdwn` blocks with its own markup, so a
 * user-supplied value must be escaped before it is interpolated into a message.
 * Otherwise `<@U123>`, `<!channel>` or `<https://example.com|label>` in the value
 * is rendered as an active mention or link, and a backtick in the value can close
 * a code span and return the rest of the line to markup.
 *
 * Plain-text block content does not need this: Slack does not parse `plain_text`
 * as markup. Use these helpers for `text` and `mrkdwn` fields only.
 */

/** Appended to a value cut by {@link truncateSlackText}. */
export const SLACK_TRUNCATION_MARKER = '… [truncated]';

/** Neutralizes the three characters Slack treats as markup delimiters. */
export function escapeSlackText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Escapes a value used inside a single line, including inside a backtick code
 * span: escapes markup delimiters, replaces backticks (which would close the
 * span) and collapses line breaks (which would forge a following message line).
 */
export function escapeSlackLabel(value: string): string {
  return escapeSlackText(value)
    .replaceAll('`', "'")
    .replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Caps a value at `limit` characters, appending {@link SLACK_TRUNCATION_MARKER}
 * so the reader can tell content was dropped. The result never exceeds `limit`
 * and never splits a surrogate pair.
 */
export function truncateSlackText(value: string, limit: number): string {
  if (value.length <= limit) return value;

  const budget = Math.max(limit - SLACK_TRUNCATION_MARKER.length, 0);
  if (budget === 0) return SLACK_TRUNCATION_MARKER.slice(0, limit);

  const head = value.slice(0, budget);
  const endsWithHighSurrogate = /[\uD800-\uDBFF]$/.test(head);
  return `${endsWithHighSurrogate ? head.slice(0, -1) : head}${SLACK_TRUNCATION_MARKER}`;
}
