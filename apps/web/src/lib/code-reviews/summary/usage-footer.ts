/**
 * Usage footer for code review summary comments.
 * Appends model + token count info to the review summary posted on GitHub/GitLab.
 */

const USAGE_FOOTER_MARKER = '<!-- kilo-usage -->';
const REVIEW_GUIDANCE_FOOTER_MARKER = '<!-- kilo-review-guidance -->';

type UsageFooterData = {
  model: string;
  tokensIn: number;
  tokensOut: number;
};

type ReviewGuidanceFooterData = {
  used: boolean;
  ref: string | null;
  truncated: boolean;
};

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
  return `${USAGE_FOOTER_MARKER}\n<sub>Reviewed by ${displayModel} · ${totalTokens} tokens</sub>`;
}

export function buildReviewGuidanceFooter(guidance: ReviewGuidanceFooterData): string {
  const ref = guidance.ref ? ` ${formatMarkdownInlineCodeSpan(guidance.ref)}` : '';
  const truncated = guidance.truncated ? ' (truncated)' : '';

  return `${REVIEW_GUIDANCE_FOOTER_MARKER}\n<sub>Review guidance: REVIEW.md from base branch${ref}${truncated}</sub>`;
}

export function appendReviewSummaryFooter(
  existingBody: string,
  footer: {
    usage?: UsageFooterData;
    reviewGuidance?: ReviewGuidanceFooterData;
  }
): string {
  const footerLines: string[] = [];

  if (footer.usage) {
    footerLines.push(
      buildUsageFooter(footer.usage.model, footer.usage.tokensIn, footer.usage.tokensOut)
    );
  }

  if (footer.reviewGuidance?.used) {
    footerLines.push(buildReviewGuidanceFooter(footer.reviewGuidance));
  }

  const bodyWithoutFooter = stripReviewSummaryFooter(existingBody);

  if (footerLines.length === 0) {
    return bodyWithoutFooter;
  }

  return `${bodyWithoutFooter}\n\n---\n${footerLines.join('\n')}`;
}

export function stripReviewSummaryFooter(existingBody: string): string {
  const markers = [USAGE_FOOTER_MARKER, REVIEW_GUIDANCE_FOOTER_MARKER];
  const markerIdx = Math.max(...markers.map(marker => existingBody.lastIndexOf(marker)));

  if (markerIdx === -1) {
    return existingBody;
  }

  const footerStart = findBackendFooterStart(existingBody, markerIdx);
  if (footerStart === null) {
    return existingBody;
  }

  return existingBody.substring(0, footerStart).trimEnd();
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
  return appendReviewSummaryFooter(existingBody, { usage: { model, tokensIn, tokensOut } });
}

function findBackendFooterStart(body: string, markerIdx: number): number | null {
  const beforeMarker = body.substring(0, markerIdx);
  const horizontalRuleMatches = Array.from(beforeMarker.matchAll(/^[ \t]*---[ \t]*$/gm));

  for (const horizontalRuleMatch of horizontalRuleMatches.reverse()) {
    const horizontalRuleIdx = horizontalRuleMatch.index;
    if (horizontalRuleIdx === undefined) {
      continue;
    }

    let footerContentStart = horizontalRuleIdx + horizontalRuleMatch[0].length;
    if (body[footerContentStart] === '\n') {
      footerContentStart += 1;
    }

    const footerContent = body.substring(footerContentStart).trim();
    if (footerContent.length > 2_000) {
      continue;
    }
    if (
      !footerContent.includes(USAGE_FOOTER_MARKER) &&
      !footerContent.includes(REVIEW_GUIDANCE_FOOTER_MARKER)
    ) {
      continue;
    }
    if (isBackendFooterContent(footerContent)) {
      return horizontalRuleIdx;
    }
  }

  return null;
}

function isBackendFooterContent(content: string): boolean {
  const allowedMarkers = new Set([USAGE_FOOTER_MARKER, REVIEW_GUIDANCE_FOOTER_MARKER]);
  const lines = content.split('\n').map(line => line.trim());

  return lines.every(line => {
    if (!line) {
      return true;
    }
    if (allowedMarkers.has(line)) {
      return true;
    }
    return line.startsWith('<sub>') && line.endsWith('</sub>');
  });
}

function formatMarkdownInlineCodeSpan(value: string): string {
  const escaped = escapeHtml(value);
  const backtickRuns = escaped.match(/`+/g) ?? [];
  const delimiterLength = Math.max(1, ...backtickRuns.map(run => run.length + 1));
  const delimiter = '`'.repeat(delimiterLength);
  const padding = delimiterLength > 1 ? ' ' : '';

  return `${delimiter}${padding}${escaped}${padding}${delimiter}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
