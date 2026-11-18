import {
  hydratePartialDiff,
  parsePatchFiles,
  SPLIT_WITH_NEWLINES,
  type FileDiffMetadata,
} from '@pierre/diffs';
import {
  MAX_WORKTREE_PATCH_LINES,
  type WorktreeFileOmissionReason,
  type WorktreeFileRecord,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';

export type WorktreeDiffExpansion =
  | { status: 'available'; diff: FileDiffMetadata }
  | { status: 'unavailable'; reason: WorktreeFileOmissionReason }
  | { status: 'complete' };

const canonicalGitHeader =
  /^diff --git [^\n]+\n(?:(?:old mode|new mode|new file mode|deleted file mode) 100(?:644|755)\n|index [0-9a-f]+\.\.[0-9a-f]+(?: 100(?:644|755))?\n)*(?:--- [^\n]+\n\+\+\+ [^\n]+\n)?$/;
const emptyGitBlobIds = [
  'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813',
];

export function parseSavedWorktreePatch(patch: string, path: string): FileDiffMetadata | null {
  try {
    if (!patch.endsWith('\n')) return null;
    const firstHunk = patch.indexOf('\n@@ ');
    const header = firstHunk < 0 ? patch : patch.slice(0, firstHunk + 1);
    if (!canonicalGitHeader.test(header)) return null;
    const patches = parsePatchFiles(patch, undefined, true);
    const parsed = patches[0];
    const file = parsed?.files[0];
    if (patches.length !== 1 || parsed?.patchMetadata || parsed?.files.length !== 1 || !file) {
      return null;
    }
    if (file.hunks.length === 0) {
      if (header.includes('\n--- ')) return null;
      const modeChange =
        file.type === 'change' &&
        file.prevMode &&
        file.mode &&
        file.prevMode !== file.mode &&
        !file.prevObjectId &&
        !file.newObjectId;
      const objectId = file.type === 'new' ? file.newObjectId : file.prevObjectId;
      const missingObjectId = file.type === 'new' ? file.prevObjectId : file.newObjectId;
      const emptyFileChange =
        (file.type === 'new' || file.type === 'deleted') &&
        file.mode &&
        objectId &&
        missingObjectId &&
        /^0+$/.test(missingObjectId) &&
        emptyGitBlobIds.some(emptyId => emptyId.startsWith(objectId));
      if (!modeChange && !emptyFileChange) return null;
    } else if (!/\n--- [^\n]+\n\+\+\+ [^\n]+\n$/.test(header)) {
      return null;
    }
    let parsedLines = header.split('\n').length - 1;
    for (const hunk of file.hunks) {
      if (
        !Number.isSafeInteger(hunk.additionStart + hunk.additionCount) ||
        !Number.isSafeInteger(hunk.deletionStart + hunk.deletionCount) ||
        (hunk.additionCount > 0 && hunk.additionStart === 0) ||
        (hunk.deletionCount > 0 && hunk.deletionStart === 0)
      ) {
        return null;
      }
      const newlineMarkers =
        hunk.hunkContent.at(-1)?.type === 'context'
          ? Number(hunk.noEOFCRAdditions || hunk.noEOFCRDeletions)
          : Number(hunk.noEOFCRAdditions) + Number(hunk.noEOFCRDeletions);
      parsedLines += 1 + hunk.unifiedLineCount + newlineMarkers;
    }
    const lines = patch.split('\n');
    if (
      parsedLines !== lines.length - 1 ||
      lines.some(line => line.startsWith('\\') && line !== '\\ No newline at end of file')
    ) {
      return null;
    }
    return { ...file, name: path, prevName: undefined };
  } catch {
    return null;
  }
}

export function selectWorktreeRenderedDiff(
  parsed: FileDiffMetadata,
  expansion: WorktreeDiffExpansion | undefined
): FileDiffMetadata {
  return expansion?.status === 'available' ? expansion.diff : parsed;
}

export function resolveWorktreeRenderedDiff(file: WorktreeFileRecord): FileDiffMetadata | null {
  const parsed =
    file.diff.status === 'available' ? parseSavedWorktreePatch(file.diff.patch, file.path) : null;
  if (!parsed) return null;
  return selectWorktreeRenderedDiff(parsed, getWorktreeDiffExpansion(file, parsed));
}

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
