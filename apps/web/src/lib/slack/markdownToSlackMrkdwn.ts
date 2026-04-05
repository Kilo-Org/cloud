/**
 * Converts standard markdown to Slack's mrkdwn format.
 * Key differences:
 * - Bold: **text** → *text*
 * - Italic: __text__ → _text_
 * - Links: [text](url) → <url|text>
 * - Headings: # heading → *heading*
 */

// Pattern to match bare URLs (not already wrapped in angle brackets or in Slack link format)
// Negative lookbehind ensures we don't match URLs already preceded by < or after |
const bareUrlPattern = /(?<![<|])https?:\/\/[^\s<>|]+/g;

/**
 * Check if a string looks like a URL
 */
function looksLikeUrl(str: string): boolean {
  return /^https?:\/\//.test(str);
}

/**
 * Wraps bare URLs in angle brackets to prevent Slack from misinterpreting
 * trailing formatting characters as part of the URL.
 * Does not wrap URLs that are already inside Slack link format <url|text>
 */
function wrapBareUrls(content: string): string {
  return content.replace(bareUrlPattern, '<$&>');
}

/**
 * Processes the content inside bold/italic markers.
 * Wraps any bare URLs found within the content.
 */
function processFormattedContent(content: string, wrapChar: string): string {
  // Wrap any bare URLs within the content
  const processedContent = wrapBareUrls(content);
  return `${wrapChar}${processedContent}${wrapChar}`;
}

/**
 * Converts a markdown link to Slack format.
 * Handles special case where text is a URL and href is not.
 */
function convertLink(text: string, href: string): string {
  // If text looks like a URL but href doesn't, swap them
  // This handles cases like [http://example.org](example.org)
  if (looksLikeUrl(text) && !looksLikeUrl(href)) {
    return `<${text}|${href}>`;
  }
  // Standard conversion: [text](url) → <url|text>
  return `<${href}|${text}>`;
}

export function markdownToSlackMrkdwn(text: string): string {
  let result = text;

  // Convert markdown links [text](url) to Slack format <url|text>
  // Handle special case where text is a URL and href is not
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, linkText: string, href: string) =>
    convertLink(linkText, href)
  );

  // Convert bold **text** to Slack *text*
  // Process any URLs inside to wrap them in angle brackets
  result = result.replace(/\*\*([^*]+)\*\*/g, (_match, content: string) =>
    processFormattedContent(content, '*')
  );

  // Convert double underscore __text__ to Slack _text_
  // Process any URLs inside to wrap them in angle brackets
  result = result.replace(/__([^_]+)__/g, (_match, content: string) =>
    processFormattedContent(content, '_')
  );

  // Convert markdown headings to bold text
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Wrap bare URLs inside single asterisks (Slack bold/italic)
  // This handles cases like *text with http://url*
  result = result.replace(/\*([^*]+)\*/g, (_match, content: string) => {
    return `*${wrapBareUrls(content)}*`;
  });

  // Wrap bare URLs inside single underscores (Slack italic)
  // This handles cases like _text with http://url_
  result = result.replace(/_([^_]+)_/g, (_match, content: string) => {
    return `_${wrapBareUrls(content)}_`;
  });

  return result;
}
