import { stripReviewSummaryFooter } from './usage-footer';

export const REVIEW_SUMMARY_HISTORY_START = '<!-- kilo-review-history -->';
export const REVIEW_SUMMARY_HISTORY_END = '<!-- /kilo-review-history -->';
export const REVIEW_SUMMARY_HISTORY_ENTRY = '<!-- kilo-review-history-entry -->';

const KILO_REVIEW_MARKER = '<!-- kilo-review -->';
const DEFAULT_HISTORY_MAX_CHARACTERS = 24_000;
const MIN_TRUNCATED_ENTRY_BODY_CHARACTERS = 300;

type BuildPreviousReviewSummaryHistoryOptions = {
  previousHeadSha?: string | null;
  maxCharacters?: number;
};

type AppendPreviousReviewSummaryHistoryOptions = {
  maxBodyCharacters?: number;
  reservedCharacters?: number;
};

type HistoryEntry = {
  heading: string;
  body: string;
};

export function stripReviewSummaryHistory(body: string): string {
  return body.replace(createHistoryBlockPattern(), '').trimEnd();
}

export function getCurrentReviewSummaryForContext(body: string): string {
  return stripLeadingKiloReviewMarker(
    stripReviewSummaryFooter(stripReviewSummaryHistory(body))
  ).trim();
}

export function appendPreviousReviewSummaryHistory(
  body: string,
  previousSummaryBody: string | null,
  previousHeadSha: string | null,
  options: AppendPreviousReviewSummaryHistoryOptions = {}
): string {
  if (!previousSummaryBody) {
    return body;
  }

  const currentSummary = stripReviewSummaryFooter(stripReviewSummaryHistory(body)).trimEnd();
  const separatorCharacters = currentSummary ? 2 : 0;
  const availableHistoryCharacters =
    options.maxBodyCharacters === undefined
      ? DEFAULT_HISTORY_MAX_CHARACTERS
      : Math.max(
          0,
          Math.min(
            DEFAULT_HISTORY_MAX_CHARACTERS,
            options.maxBodyCharacters -
              currentSummary.length -
              separatorCharacters -
              (options.reservedCharacters ?? 0)
          )
        );
  const history = buildPreviousReviewSummaryHistory(previousSummaryBody, {
    previousHeadSha,
    maxCharacters: availableHistoryCharacters,
  });

  if (!history) {
    return currentSummary;
  }

  return currentSummary ? `${currentSummary}\n\n${history}` : history;
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
  });
}

function createHistoryBlockPattern(): RegExp {
  return new RegExp(
    `^[ \\t]*${escapeRegExp(REVIEW_SUMMARY_HISTORY_START)}[ \\t]*(?:\\r?\\n)[\\s\\S]*?^[ \\t]*${escapeRegExp(REVIEW_SUMMARY_HISTORY_END)}[ \\t]*(?:\\r?\\n)?`,
    'gm'
  );
}

function prepareVisibleSummaryForHistory(body: string): string {
  return stripFixLinkSection(
    stripLeadingCodeReviewHeading(getCurrentReviewSummaryForContext(body))
  ).trim();
}

function extractExistingHistoryEntries(body: string): HistoryEntry[] {
  return Array.from(body.matchAll(createHistoryBlockPattern())).flatMap(match => {
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

function renderHistoryBlock(
  entries: HistoryEntry[],
  options: { previousHeadSha?: string | null; maxCharacters: number }
): string {
  const header = renderHistoryHeader(entries.length, options.previousHeadSha);
  const footer = `\n</details>\n${REVIEW_SUMMARY_HISTORY_END}`;
  const renderedEntries: string[] = [];
  let truncated = false;

  for (const entry of entries) {
    const candidateEntries = [...renderedEntries, renderHistoryEntry(entry)];
    const candidate = renderHistoryBlockParts(header, candidateEntries, footer, truncated);

    if (candidate.length <= options.maxCharacters) {
      renderedEntries.push(renderHistoryEntry(entry));
      continue;
    }

    const truncatedEntry = truncateEntryToFit(
      header,
      renderedEntries,
      footer,
      entry,
      options.maxCharacters
    );
    if (truncatedEntry) {
      renderedEntries.push(truncatedEntry);
    }
    truncated = true;
    break;
  }

  if (renderedEntries.length === 0) {
    return '';
  }

  const renderedHeader = renderHistoryHeader(renderedEntries.length, options.previousHeadSha);
  return renderHistoryBlockParts(renderedHeader, renderedEntries, footer, truncated);
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
  maxCharacters: number
): string | null {
  const entryPrefix = `${REVIEW_SUMMARY_HISTORY_ENTRY}\n${entry.heading}\n\n`;
  const separatorLength = renderedEntries.length > 0 ? 2 : 0;
  const fixedLength =
    renderHistoryBlockParts(header, renderedEntries, footer, true).length +
    separatorLength +
    entryPrefix.length;
  let availableBodyCharacters = maxCharacters - fixedLength;

  while (availableBodyCharacters >= MIN_TRUNCATED_ENTRY_BODY_CHARACTERS) {
    const truncatedBody = truncateMarkdownFragment(entry.body, availableBodyCharacters);
    const renderedEntry = `${entryPrefix}${truncatedBody}`;
    const fullBlock = renderHistoryBlockParts(
      header,
      [...renderedEntries, renderedEntry],
      footer,
      true
    );

    if (fullBlock.length <= maxCharacters) {
      return renderedEntry;
    }

    availableBodyCharacters -= fullBlock.length - maxCharacters;
  }

  return null;
}

function truncateMarkdownFragment(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }

  const suffix = '\n\n_[Snapshot truncated.]_';
  const truncated = value.slice(0, Math.max(0, maxCharacters - suffix.length)).trimEnd();
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
