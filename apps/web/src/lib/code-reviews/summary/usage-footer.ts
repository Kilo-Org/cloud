/**
 * Usage footer for code review summary comments.
 * Appends model + token count info to the review summary posted on GitHub/GitLab.
 */

import {
  USAGE_FOOTER_MARKER,
  REVIEW_GUIDANCE_FOOTER_MARKER,
  stripReviewSummaryFooter,
} from '@kilocode/worker-utils/review-summary-cleaning';

export { stripReviewSummaryFooter };

type UsageFooterData = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
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

const tokenCountFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export function formatTokenCount(count: number): string {
  return tokenCountFormatter.format(count);
}

export function buildUsageFooter(
  model: string,
  tokensIn: number,
  tokensOut: number,
  cachedTokens: number
): string {
  const displayModel = formatModelName(model);
  return `${USAGE_FOOTER_MARKER}\n<sub>Reviewed by ${displayModel} · Input: ${formatTokenCount(tokensIn)} · Output: ${formatTokenCount(tokensOut)} · Cached: ${formatTokenCount(cachedTokens)}</sub>`;
}

export function buildReviewGuidanceFooter(guidance: ReviewGuidanceFooterData): string {
  const ref = guidance.ref ? ` ${formatMarkdownInlineCodeSpan(guidance.ref)}` : '';
  const truncated = guidance.truncated ? ' (truncated)' : '';

  return `${REVIEW_GUIDANCE_FOOTER_MARKER}\n<sub>Review guidance: REVIEW.md from base branch${ref}${truncated}</sub>`;
}

export function buildReviewSummaryFooter(footer: {
  usage?: UsageFooterData;
  reviewGuidance?: ReviewGuidanceFooterData;
}): string {
  const footerLines: string[] = [];

  if (footer.usage) {
    footerLines.push(
      buildUsageFooter(
        footer.usage.model,
        footer.usage.tokensIn,
        footer.usage.tokensOut,
        footer.usage.cachedTokens
      )
    );
  }

  if (footer.reviewGuidance?.used) {
    footerLines.push(buildReviewGuidanceFooter(footer.reviewGuidance));
  }

  return footerLines.length > 0 ? `\n\n---\n${footerLines.join('\n')}` : '';
}

export function appendReviewSummaryFooter(
  existingBody: string,
  footer: {
    usage?: UsageFooterData;
    reviewGuidance?: ReviewGuidanceFooterData;
  }
): string {
  return `${stripReviewSummaryFooter(existingBody)}${buildReviewSummaryFooter(footer)}`;
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
  return appendReviewSummaryFooter(existingBody, {
    usage: { model, tokensIn, tokensOut, cachedTokens: 0 },
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
