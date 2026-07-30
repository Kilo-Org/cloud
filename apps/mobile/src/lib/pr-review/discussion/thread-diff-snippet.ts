// Pure selector for the quoted diff snippet shown above comments in an
// expanded LINE-anchored discussion thread.
//
// GitHub's GraphQL has `diffHunk` on the anchor review comment (not the
// thread). The backend DTO lifts it to thread-level `diffHunk`. This
// helper parses that string with the same `parsePatch` the Files tab
// uses, flattens hunk body lines (no `@@` header — the thread header
// already names file + lines), and caps the rendered set so multi-line
// anchors don't blow card height. The cap keeps the TAIL of the hunk
// (GitHub's diffHunk ends at the anchored line, so the comment's line
// always renders). Outdated threads need no special casing: their
// `diffHunk` IS the original hunk.

import { languageForPath } from '@/lib/pr-review/diff/highlight';
import { type ParsedDiffLine, parsePatch } from '@/lib/pr-review/diff/parse-patch';
import { type ReviewThread } from '@/lib/pr-review/discussion/review-discussion-types';

/** Max body lines rendered in a thread's quoted snippet. */
export const THREAD_SNIPPET_MAX_LINES = 30;

export type ThreadDiffSnippetInput = Pick<ReviewThread, 'diffHunk' | 'subjectType' | 'path'>;

export type ThreadDiffSnippet = {
  readonly lines: readonly ParsedDiffLine[];
  /** Uncapped count of parsed body lines (may exceed `lines.length`). */
  readonly totalLineCount: number;
  readonly language: string | null;
};

/**
 * Select the quoted diff snippet for a review thread, or `null` when
 * there is nothing to show (file-level subject, missing/empty hunk, or
 * unparseable / empty body after parse).
 */
export function selectThreadDiffSnippet(thread: ThreadDiffSnippetInput): ThreadDiffSnippet | null {
  if (thread.subjectType === 'FILE') {
    return null;
  }
  const hunk = thread.diffHunk;
  if (hunk == null || hunk === '') {
    return null;
  }

  const parsed = parsePatch(hunk);
  const allLines: ParsedDiffLine[] = [];
  for (const h of parsed.hunks) {
    for (const line of h.lines) {
      allLines.push(line);
    }
  }
  if (allLines.length === 0) {
    return null;
  }

  return {
    lines: allLines.slice(-THREAD_SNIPPET_MAX_LINES),
    totalLineCount: allLines.length,
    language: languageForPath(thread.path),
  };
}
