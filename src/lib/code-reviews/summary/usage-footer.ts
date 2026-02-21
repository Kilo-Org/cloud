/**
 * Usage footer for code review summary comments.
 * Appends model + token count info to the review summary posted on GitHub/GitLab.
 */

const USAGE_FOOTER_MARKER = '<!-- kilo-usage -->';

/**
 * Format a model slug for display (strip provider prefix)
 * e.g., 'anthropic/claude-sonnet-4.6' -> 'claude-sonnet-4.6'
 */
function formatModelName(modelSlug: string): string {
  const parts = modelSlug.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : modelSlug;
}

/**
 * Format a token count with thousands separators
 */
function formatTokenCount(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * Build the usage footer line
 * e.g., "Model: claude-sonnet-4.6 · Tokens: 12,345 in, 1,234 out"
 */
export function buildUsageFooter(model: string, tokensIn: number, tokensOut: number): string {
  const displayModel = formatModelName(model);
  const totalTokens = formatTokenCount(tokensIn + tokensOut);
  return `\n\n---\n${USAGE_FOOTER_MARKER}\n<sub>Reviewed by ${displayModel} · ${totalTokens} tokens</sub>`;
}

/**
 * Append usage footer to an existing review comment body.
 * If a footer already exists (from a previous review pass), it is replaced.
 */
export function appendUsageFooter(
  existingBody: string,
  model: string,
  tokensIn: number,
  tokensOut: number
): string {
  const footer = buildUsageFooter(model, tokensIn, tokensOut);

  // Remove existing footer if present (from a previous review pass).
  // Search for the full footer delimiter pattern to avoid matching
  // unrelated horizontal rules in the review body.
  const footerPattern = '\n\n---\n' + USAGE_FOOTER_MARKER;
  const patternIdx = existingBody.indexOf(footerPattern);
  if (patternIdx !== -1) {
    return existingBody.substring(0, patternIdx) + footer;
  }

  // Also handle edge case where footer exists but with different leading whitespace
  const markerIdx = existingBody.indexOf(USAGE_FOOTER_MARKER);
  if (markerIdx !== -1) {
    // Walk backwards to find the preceding newline and ---
    let start = markerIdx;
    // Skip backwards over any whitespace/newlines between --- and marker
    while (start > 0 && existingBody[start - 1] === '\n') {
      start--;
    }
    // Check if we're at a ---
    if (start >= 3 && existingBody.substring(start - 3, start) === '---') {
      start -= 3;
      // Remove leading newlines before ---
      while (start > 0 && existingBody[start - 1] === '\n') {
        start--;
      }
    }
    return existingBody.substring(0, start) + footer;
  }

  return existingBody + footer;
}
