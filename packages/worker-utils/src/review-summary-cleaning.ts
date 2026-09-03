export const REVIEW_SUMMARY_HISTORY_START = '<!-- kilo-review-history -->';
export const REVIEW_SUMMARY_HISTORY_END = '<!-- /kilo-review-history -->';
export const USAGE_FOOTER_MARKER = '<!-- kilo-usage -->';
export const REVIEW_GUIDANCE_FOOTER_MARKER = '<!-- kilo-review-guidance -->';

export function stripReviewSummaryHistory(body: string): string {
  return body.replace(createReviewSummaryHistoryBlockPattern(), '').trimEnd();
}

export function createReviewSummaryHistoryBlockPattern(): RegExp {
  return new RegExp(
    `^[ \\t]*${escapeRegExp(REVIEW_SUMMARY_HISTORY_START)}[ \\t]*(?:\\r?\\n)[\\s\\S]*?^[ \\t]*${escapeRegExp(REVIEW_SUMMARY_HISTORY_END)}[ \\t]*(?:\\r?\\n)?`,
    'gm'
  );
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
