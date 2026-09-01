import type {
  GetWorktreeFileOutput,
  WorktreeChangesSnapshot,
  WorktreeFileOmissionReason,
  WorktreeFileRecord,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { WorktreeFileViewMode } from './workspace-tabs';

export type SavedWorktreeFileState =
  | Extract<GetWorktreeFileOutput, { status: 'available' | 'omitted' }>
  | { status: 'loading' | 'error' | 'stale' | 'not_captured' | 'no_longer_listed' };

export function getSavedWorktreeFileState({
  snapshot,
  path,
  result,
  summaryError,
  fileError,
}: {
  snapshot: WorktreeChangesSnapshot | null | undefined;
  path: string;
  result: GetWorktreeFileOutput | undefined;
  summaryError: boolean;
  fileError: boolean;
}): SavedWorktreeFileState {
  if (summaryError) return { status: 'error' };
  if (snapshot === undefined) return { status: 'loading' };
  if (snapshot === null) return { status: 'not_captured' };
  if (!snapshot.files.some(file => file.path === path)) return { status: 'no_longer_listed' };
  if (fileError) return { status: 'error' };
  if (!result) return { status: 'loading' };
  if (result.status === 'available' || result.status === 'omitted') {
    if (result.file.path !== path) return { status: 'error' };
    if (result.file.revision !== snapshot.revision) return { status: 'stale' };
    return result;
  }
  return { status: result.status };
}

export function isWorktreeMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function getWorktreeFileViewMode(
  file: WorktreeFileRecord,
  mode: WorktreeFileViewMode | undefined
): WorktreeFileViewMode {
  if (file.content.status !== 'available') return 'diff';
  if (mode === 'expanded') return mode;
  return mode === 'preview' && isWorktreeMarkdownPath(file.path) ? 'preview' : 'diff';
}

export const worktreeFileOmissionMessages: Record<WorktreeFileOmissionReason, string> = {
  binary: 'This is a binary file.',
  unsupported: 'This file type is not supported.',
  invalid_utf8: 'The file is not valid UTF-8 text.',
  too_large: 'The saved size limit was exceeded.',
  line_limit: 'The 10,000-line rendering limit was exceeded.',
  budget_exhausted: 'The capture budget was exhausted.',
  inconsistent: 'The file changed during capture.',
  capture_failed: 'The file could not be captured.',
};
