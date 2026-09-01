import { hydratePartialDiff, SPLIT_WITH_NEWLINES, type FileDiffMetadata } from '@pierre/diffs';
import {
  MAX_WORKTREE_PATCH_LINES,
  type WorktreeFileOmissionReason,
  type WorktreeFileRecord,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';

export type WorktreeDiffExpansion =
  | { status: 'available'; diff: FileDiffMetadata }
  | { status: 'unavailable'; reason: WorktreeFileOmissionReason }
  | { status: 'complete' };

export function getWorktreeDiffExpansion(
  file: WorktreeFileRecord,
  parsed: FileDiffMetadata
): WorktreeDiffExpansion {
  if (parsed.type === 'new' || parsed.type === 'deleted') return { status: 'complete' };
  if (file.content.status === 'unavailable') {
    return { status: 'unavailable', reason: file.content.reason };
  }
  if (file.content.source !== 'current') {
    return { status: 'unavailable', reason: 'inconsistent' };
  }

  try {
    const currentText = file.content.text;
    const currentLines = currentText === '' ? [] : currentText.split(SPLIT_WITH_NEWLINES);
    const oldLines: string[] = [];
    let currentEnd = 0;
    let additionIndex = 0;
    let deletionIndex = 0;
    let expandedLineCount =
      currentLines.length + Number(parsed.hunks.length === 0 && currentText.endsWith('\n'));
    let hasHiddenLines = false;

    for (const hunk of parsed.hunks) {
      const additionStart = hunk.additionStart - (hunk.additionCount === 0 ? 0 : 1);
      const deletionStart = hunk.deletionStart - (hunk.deletionCount === 0 ? 0 : 1);
      const unchangedLines = additionStart - currentEnd;
      if (
        ![
          hunk.additionStart,
          hunk.additionCount,
          hunk.additionLineIndex,
          hunk.deletionStart,
          hunk.deletionCount,
          hunk.deletionLineIndex,
        ].every(value => Number.isSafeInteger(value) && value >= 0) ||
        unchangedLines < 0 ||
        deletionStart - oldLines.length !== unchangedLines ||
        additionStart + hunk.additionCount > currentLines.length ||
        hunk.additionLineIndex !== additionIndex ||
        hunk.deletionLineIndex !== deletionIndex ||
        additionIndex + hunk.additionCount > parsed.additionLines.length ||
        deletionIndex + hunk.deletionCount > parsed.deletionLines.length
      ) {
        return { status: 'unavailable', reason: 'inconsistent' };
      }

      for (let index = 0; index < hunk.additionCount; index++) {
        if (currentLines[additionStart + index] !== parsed.additionLines[additionIndex + index]) {
          return { status: 'unavailable', reason: 'inconsistent' };
        }
      }

      oldLines.push(
        ...currentLines.slice(currentEnd, additionStart),
        ...parsed.deletionLines.slice(deletionIndex, deletionIndex + hunk.deletionCount)
      );
      currentEnd = additionStart + hunk.additionCount;
      additionIndex += hunk.additionCount;
      deletionIndex += hunk.deletionCount;
      const newlineMarkers =
        hunk.hunkContent.at(-1)?.type === 'context'
          ? Number(hunk.noEOFCRAdditions || hunk.noEOFCRDeletions)
          : Number(hunk.noEOFCRAdditions) + Number(hunk.noEOFCRDeletions);
      expandedLineCount += hunk.unifiedLineCount - hunk.additionCount + newlineMarkers;
      hasHiddenLines ||= unchangedLines > 0;
    }

    hasHiddenLines ||= currentEnd < currentLines.length;
    oldLines.push(...currentLines.slice(currentEnd));
    if (
      additionIndex !== parsed.additionLines.length ||
      deletionIndex !== parsed.deletionLines.length ||
      oldLines.some(
        (line, index) => line === '' || (index < oldLines.length - 1 && !line.endsWith('\n'))
      )
    ) {
      return { status: 'unavailable', reason: 'inconsistent' };
    }
    if (expandedLineCount > MAX_WORKTREE_PATCH_LINES) {
      return { status: 'unavailable', reason: 'line_limit' };
    }
    if (!hasHiddenLines) return { status: 'complete' };
    if (
      file.diff.status === 'available' &&
      file.diff.patch.includes('\r\n\\ No newline at end of file\n')
    ) {
      return { status: 'unavailable', reason: 'inconsistent' };
    }

    const diff = hydratePartialDiff('clone', parsed, {
      oldFile: { name: file.path, contents: oldLines.join('') },
      newFile: { name: file.path, contents: currentText },
    });
    return { status: 'available', diff };
  } catch {
    return { status: 'unavailable', reason: 'inconsistent' };
  }
}
