/**
 * Pure reporting helpers for an incomplete session restore. No filesystem, no
 * I/O: the wrapper produces the diff outcome, and the worker relays the same
 * named report to the agent (rules/skill) and to the user.
 */

export type RestoreIncompleteReport = {
  applied: number;
  skipped: number;
  total: number;
  /** Distinct named reasons, first-seen order. */
  reasons: string[];
  /** Affected workspace-relative paths, first-seen order, capped at 50. */
  paths: string[];
  /** Distinct affected paths beyond the cap, omitted from `paths`. */
  omittedPaths: number;
  message: string;
};

/** Paths listed in `message`/`paths` before the remainder is summarised. */
const MAX_REPORTED_PATHS = 50;

/** Longest snapshot path rendered into the rules note before it is elided, in code points. */
const MAX_RENDERED_PATH_LENGTH = 200;

const RESTORE_SKIP_REASON_WORDS: Record<string, string> = {
  patch_apply_failed: 'the patch did not apply',
  outside_workspace: 'the path is outside the workspace',
  missing_content: 'the snapshot carried no content for the file',
  index_reset_failed: 'the index could not be reset after a failed apply',
  unlink_failed: 'the file could not be removed',
  write_failed: 'the file could not be written',
};

/** Human-readable wording for a skip reason; unknown reasons pass through verbatim. */
function describeReason(reason: string): string {
  return RESTORE_SKIP_REASON_WORDS[reason] ?? reason;
}

/** Characters that could open Markdown structure or raw HTML inside the note. */
const MARKDOWN_SYNTAX_CHARS = new Set(['\\', '`', '*', '_', '[', ']', '<', '>', '&', '~', '|']);

/** True for a control character or Unicode line separator, which must never reach the note. */
function isControlOrLineSeparator(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/**
 * Render one snapshot path as data rather than as Markdown. The rules note is
 * read as agent instructions and a path arrives from the restored snapshot, so
 * a path carrying a line break or Markdown syntax must not be able to add a
 * bullet, a section, or an instruction. Line and control characters become
 * visible `\uXXXX` escapes (never a line break), Markdown syntax is
 * backslash-escaped, and the path is capped before insertion.
 */
function renderPathAsData(file: string): string {
  const codePoints = [...file];
  const bounded =
    codePoints.length > MAX_RENDERED_PATH_LENGTH
      ? `${codePoints.slice(0, MAX_RENDERED_PATH_LENGTH).join('')}…`
      : file;
  let rendered = '';
  for (const char of bounded) {
    const code = char.codePointAt(0) ?? 0;
    if (isControlOrLineSeparator(code)) {
      rendered += `\\u${code.toString(16).padStart(4, '0')}`;
    } else if (MARKDOWN_SYNTAX_CHARS.has(char)) {
      rendered += `\\${char}`;
    } else {
      rendered += char;
    }
  }
  return rendered;
}

/**
 * Build the named incomplete-restore report, or `undefined` when every diff
 * applied. A missing `skippedDiffs` record (an older wrapper) reports the
 * reason as `unknown` rather than dropping the fact that the restore is short.
 */
export function buildRestoreIncompleteReport(diffs: {
  applied: number;
  skipped: number;
  total: number;
  skippedDiffs?: { file: string; reason: string }[];
}): RestoreIncompleteReport | undefined {
  if (diffs.skipped === 0) return undefined;

  const retainedDiffs = diffs.skippedDiffs ?? [];
  const reasons: string[] = [];
  const paths: string[] = [];
  for (const entry of retainedDiffs) {
    const reason =
      typeof entry?.reason === 'string' && entry.reason.length > 0 ? entry.reason : 'unknown';
    if (!reasons.includes(reason)) reasons.push(reason);
    const file = typeof entry?.file === 'string' ? entry.file : '';
    if (file.length > 0 && !paths.includes(file)) paths.push(file);
  }
  if (reasons.length === 0) reasons.push('unknown');

  // The wrapper bounds the records it retains, so a shorter record list than
  // `skipped` means the cap dropped records. The remainder must then come from
  // the true total: restore diffs are deduplicated by file, so `skipped` is the
  // number of distinct skipped paths. Deriving it from the retained records
  // instead would understate how many paths the report omitted.
  const recordsCapped = retainedDiffs.length < diffs.skipped;
  const distinctPaths = recordsCapped ? diffs.skipped : paths.length;
  const listedPaths = paths.slice(0, MAX_REPORTED_PATHS);
  const omittedPaths = Math.max(0, distinctPaths - listedPaths.length);
  const missing =
    listedPaths.length > 0
      ? ` Missing: ${listedPaths.join(', ')}${omittedPaths > 0 ? ` and ${omittedPaths} more` : ''}`
      : '';
  const message = `Session restore incomplete: ${diffs.skipped} of ${diffs.total} files were not restored (${reasons
    .map(describeReason)
    .join(', ')}).${missing}`;

  return {
    applied: diffs.applied,
    skipped: diffs.skipped,
    total: diffs.total,
    reasons,
    paths: listedPaths,
    omittedPaths,
    message,
  };
}

/**
 * Markdown injected into the agent's context (rules/skill path) so it learns the
 * worktree is incomplete before it continues. It must not assume the affected
 * paths exist.
 */
export function buildRestoreIncompleteRules(report: RestoreIncompleteReport): string {
  const lines = [
    '## Session restore incomplete',
    '',
    `The worktree was restored from a snapshot, but ${report.skipped} of ${report.total} files could not be restored.`,
    '',
    'Skipped because:',
    ...report.reasons.map(reason => `- ${describeReason(reason)}`),
  ];
  if (report.paths.length > 0) {
    lines.push(
      '',
      'Affected paths:',
      ...report.paths.map(file => `- ${renderPathAsData(file)}`),
      // The report caps the list; without the remainder an agent could read the
      // listed paths as the whole set.
      ...(report.omittedPaths > 0 ? [`- and ${report.omittedPaths} more`] : [])
    );
  }
  lines.push(
    '',
    'Do not assume these paths are present in the worktree. Re-read or re-create each one from the conversation before continuing.'
  );
  return lines.join('\n');
}
