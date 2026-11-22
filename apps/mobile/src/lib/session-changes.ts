// Session diff → the PR diff viewer's file shape, so the session changes
// screen reuses the PR diff rows. Pure, so it runs in plain Node tests.

import { providerPrFileStatus } from '@kilocode/app-shared/provider-review';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';

type SessionDiff = inferRouterOutputs<MobileRouter>['cliSessionsV2']['getSessionDiff'];
export type SessionDiffFile = Extract<SessionDiff, { kind: 'files' }>['files'][number];

/**
 * The status goes through `providerPrFileStatus`, which names a deleted file
 * `removed` and a word the UI has no label for `unknown`; a file without a
 * status is a modification. An empty patch is a binary file: it has no hunks
 * to render, which is what `patchMissingCause: 'binary'` says.
 */
export function sessionDiffFileToPrReviewFile(file: SessionDiffFile): PrReviewFile {
  return {
    path: file.file,
    previousPath: null,
    status: providerPrFileStatus(file.status ?? 'modified'),
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch || null,
    patchMissingCause: file.patch === '' ? 'binary' : null,
  };
}
