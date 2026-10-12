// Session diff → the PR diff viewer's file shape, so the session changes
// screen reuses the PR diff rows. Pure, so it runs in plain Node tests.

import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

type SessionDiff = inferRouterOutputs<MobileRouter>['cliSessionsV2']['getSessionDiff'];
export type SessionDiffFile = Extract<SessionDiff, { kind: 'files' }>['files'][number];

/**
 * The PR status vocabulary (`pr-diff-file-status.ts`) names a deleted file
 * `removed`. A file without a status is a modification. An empty patch is a
 * binary file: it has no hunks to render.
 */
export function sessionDiffFileToPrReviewFile(file: SessionDiffFile): PrReviewFile {
  return {
    path: file.file,
    previousPath: null,
    status: file.status === 'deleted' ? 'removed' : (file.status ?? 'modified'),
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch || null,
    patchMissing: file.patch === '',
  };
}
