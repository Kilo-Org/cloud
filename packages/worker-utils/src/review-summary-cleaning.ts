export const REVIEW_SUMMARY_HISTORY_START = '<!-- kilo-review-history -->';
export const REVIEW_SUMMARY_HISTORY_END = '<!-- /kilo-review-history -->';
export const REVIEW_SUMMARY_HISTORY_ENTRY = '<!-- kilo-review-history-entry -->';
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

const KILO_REVIEW_MARKER = '<!-- kilo-review -->';
const DEFAULT_HISTORY_MAX_CHARACTERS = 24_000;
const MIN_TRUNCATED_ENTRY_BODY_CHARACTERS = 300;
const historyEncoder = new TextEncoder();

type BuildPreviousReviewSummaryHistoryOptions = {
  previousHeadSha?: string | null;
  maxCharacters?: number;
  maxBytes?: number;
};

type HistoryEntry = {
  heading: string;
  body: string;
};

type HistoryBudget = { maxCharacters: number; maxBytes: number };

export function getCurrentReviewSummaryForContext(body: string): string {
  return stripLeadingKiloReviewMarker(
    stripReviewSummaryFooter(stripReviewSummaryHistory(body))
  ).trim();
}

export function buildPreviousReviewSummaryHistory(
  body: string,
  options: BuildPreviousReviewSummaryHistoryOptions = {}
): string {
  const visibleSummary = prepareVisibleSummaryForHistory(body);
  const existingEntries = extractExistingHistoryEntries(body);
  const entries: HistoryEntry[] = [];

  if (visibleSummary) {
    entries.push({
      heading: `### Previous review${formatCommitSuffix(options.previousHeadSha)}`,
      body: visibleSummary,
    });
  }

  entries.push(...existingEntries);

  if (entries.length === 0) {
    return '';
  }

  return renderHistoryBlock(entries, {
    previousHeadSha: options.previousHeadSha,
    maxCharacters: options.maxCharacters ?? DEFAULT_HISTORY_MAX_CHARACTERS,
    maxBytes: options.maxBytes ?? Number.POSITIVE_INFINITY,
  });
}

function prepareVisibleSummaryForHistory(body: string): string {
  return stripFixLinkSection(
    stripLeadingCodeReviewHeading(getCurrentReviewSummaryForContext(body))
  ).trim();
}

function extractExistingHistoryEntries(body: string): HistoryEntry[] {
  return Array.from(body.matchAll(createReviewSummaryHistoryBlockPattern())).flatMap(match => {
    const block = match[0];
    const withoutOuterMarkers = block
      .replace(createLineMarkerPattern(REVIEW_SUMMARY_HISTORY_START), '')
      .replace(createLineMarkerPattern(REVIEW_SUMMARY_HISTORY_END), '')
      .trim();
    const withoutOuterDetails = stripFinalOuterDetails(withoutOuterMarkers);

    return withoutOuterDetails
      .split(REVIEW_SUMMARY_HISTORY_ENTRY)
      .slice(1)
      .map(normalizeExistingHistoryEntry)
      .filter((entry): entry is HistoryEntry => entry !== null);
  });
}

function normalizeExistingHistoryEntry(entry: string): HistoryEntry | null {
  const withoutNestedHistory = stripReviewSummaryFooter(stripReviewSummaryHistory(entry))
    .replaceAll(REVIEW_SUMMARY_HISTORY_ENTRY, '')
    .trim();
  const withoutMarker = stripFixLinkSection(
    stripLeadingKiloReviewMarker(withoutNestedHistory)
  ).trim();
  const lines = withoutMarker.split('\n');
  const headingLine = lines[0]?.trim();

  if (!headingLine) {
    return null;
  }

  if (headingLine.startsWith('### ')) {
    const body = lines.slice(1).join('\n').trim();
    return body ? { heading: headingLine, body } : null;
  }

  const body = stripLeadingCodeReviewHeading(withoutMarker).trim();
  return body ? { heading: '### Previous review', body } : null;
}

function fitsHistoryBudget(value: string, budget: HistoryBudget): boolean {
  return (
    value.length <= budget.maxCharacters &&
    historyEncoder.encode(value).byteLength <= budget.maxBytes
  );
}

function renderHistoryBlock(
  entries: HistoryEntry[],
  options: HistoryBudget & { previousHeadSha?: string | null }
): string {
  const header = renderHistoryHeader(entries.length, options.previousHeadSha);
  const footer = `\n</details>\n${REVIEW_SUMMARY_HISTORY_END}`;
  const complete = renderHistoryBlockParts(header, entries.map(renderHistoryEntry), footer, false);
  if (fitsHistoryBudget(complete, options)) return complete;

  const renderedEntries: string[] = [];
  for (const entry of entries) {
    const renderedEntry = renderHistoryEntry(entry);
    const candidate = renderHistoryBlockParts(
      header,
      [...renderedEntries, renderedEntry],
      footer,
      true
    );

    if (fitsHistoryBudget(candidate, options)) {
      renderedEntries.push(renderedEntry);
      continue;
    }

    const truncatedEntry = truncateEntryToFit(header, renderedEntries, footer, entry, options);
    if (truncatedEntry) renderedEntries.push(truncatedEntry);
    break;
  }

  if (renderedEntries.length === 0) return '';

  const renderedHeader = renderHistoryHeader(renderedEntries.length, options.previousHeadSha);
  return renderHistoryBlockParts(renderedHeader, renderedEntries, footer, true);
}

function renderHistoryHeader(entryCount: number, previousHeadSha?: string | null): string {
  return [
    REVIEW_SUMMARY_HISTORY_START,
    '<details>',
    `<summary>${formatHistorySummary(entryCount, previousHeadSha)}</summary>`,
    '',
    '_Current summary above is authoritative. Previous snapshots are kept for context only._',
    '',
  ].join('\n');
}

function renderHistoryBlockParts(
  header: string,
  entries: string[],
  footer: string,
  truncated: boolean
): string {
  const truncationNote = truncated
    ? '\n\n_Additional previous summary content was truncated to keep this comment within platform limits._'
    : '';

  return `${header}${entries.join('\n\n')}${truncationNote}${footer}`;
}

function renderHistoryEntry(entry: HistoryEntry): string {
  return `${REVIEW_SUMMARY_HISTORY_ENTRY}\n${entry.heading}\n\n${entry.body}`;
}

function truncateEntryToFit(
  header: string,
  renderedEntries: string[],
  footer: string,
  entry: HistoryEntry,
  budget: HistoryBudget
): string | null {
  const entryPrefix = `${REVIEW_SUMMARY_HISTORY_ENTRY}\n${entry.heading}\n\n`;
  const separator = renderedEntries.length > 0 ? '\n\n' : '';
  const fixed =
    renderHistoryBlockParts(header, renderedEntries, footer, true) + separator + entryPrefix;
  const available = {
    maxCharacters: budget.maxCharacters - fixed.length,
    maxBytes: budget.maxBytes - historyEncoder.encode(fixed).byteLength,
  };

  while (
    available.maxCharacters >= MIN_TRUNCATED_ENTRY_BODY_CHARACTERS &&
    available.maxBytes >= MIN_TRUNCATED_ENTRY_BODY_CHARACTERS
  ) {
    const truncatedBody = truncateMarkdownFragment(entry.body, available);
    const renderedEntry = `${entryPrefix}${truncatedBody}`;
    const fullBlock = renderHistoryBlockParts(
      header,
      [...renderedEntries, renderedEntry],
      footer,
      true
    );

    if (fitsHistoryBudget(fullBlock, budget)) return renderedEntry;

    available.maxCharacters -= Math.max(0, fullBlock.length - budget.maxCharacters);
    available.maxBytes -= Math.max(
      0,
      historyEncoder.encode(fullBlock).byteLength - budget.maxBytes
    );
  }

  return null;
}

function truncateMarkdownFragment(value: string, budget: HistoryBudget): string {
  if (fitsHistoryBudget(value, budget)) return value;

  const suffix = '\n\n_[Snapshot truncated.]_';
  let end = Math.min(value.length, Math.max(0, budget.maxCharacters - suffix.length));
  if (end > 0 && /[\uD800-\uDBFF]/.test(value.charAt(end - 1))) end--;
  const bytes = historyEncoder.encode(value.slice(0, end));
  let byteEnd = Math.min(bytes.byteLength, Math.max(0, budget.maxBytes - suffix.length));
  while (byteEnd > 0 && byteEnd < bytes.byteLength && (bytes[byteEnd] & 0xc0) === 0x80) byteEnd--;
  const truncated = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(bytes.subarray(0, byteEnd))
    .trimEnd();
  return `${truncated}${suffix}${closingDetailsFor(truncated)}`;
}

function closingDetailsFor(value: string): string {
  const openCount = value.match(/<details\b/gi)?.length ?? 0;
  const closeCount = value.match(/<\/details>/gi)?.length ?? 0;
  const missingCount = Math.max(0, openCount - closeCount);

  return missingCount > 0 ? `\n${'</details>\n'.repeat(missingCount).trimEnd()}` : '';
}

function formatHistorySummary(entryCount: number, previousHeadSha?: string | null): string {
  const commitSuffix = formatCommitSuffix(previousHeadSha);

  if (entryCount === 1) {
    return `<b>Previous Review Summary</b>${commitSuffix}`;
  }

  const latestCommitText = previousHeadSha
    ? `, latest commit ${formatShortSha(previousHeadSha)}`
    : '';
  return `<b>Previous Review Summaries</b> (${entryCount} snapshots${latestCommitText})`;
}

function formatCommitSuffix(previousHeadSha?: string | null): string {
  return previousHeadSha ? ` (commit ${formatShortSha(previousHeadSha)})` : '';
}

function formatShortSha(sha: string): string {
  return sha.slice(0, 7);
}

function stripLeadingKiloReviewMarker(body: string): string {
  return body
    .trimStart()
    .replace(new RegExp(`^${escapeRegExp(KILO_REVIEW_MARKER)}[ \\t]*(?:\\r?\\n)?`), '')
    .trimStart();
}

function stripLeadingCodeReviewHeading(body: string): string {
  return body
    .trimStart()
    .replace(/^##[ \t]+Code Review[^\r\n]*(?:\r?\n)+/, '')
    .trimStart();
}

function stripFixLinkSection(body: string): string {
  return body.replace(
    /^##[ \t]+Fix Link(?:[ \t]*\([^\r\n]*\))?[ \t]*(?:\r?\n|$)[\s\S]*?(?=^##[ \t]+|(?![\s\S]))/gim,
    ''
  );
}

function stripFinalOuterDetails(value: string): string {
  return value.replace(/\n<\/details>[ \t]*(?:\r?\n)?$/i, '');
}

function createLineMarkerPattern(marker: string): RegExp {
  return new RegExp(`^[ \\t]*${escapeRegExp(marker)}[ \\t]*(?:\\r?\\n)?`, 'm');
}
