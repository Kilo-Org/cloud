// S7a mutation hooks for inline PR review comments and the pending-
// review batch submit. The pattern mirrors the existing S8 merge
// mutations:
//   - `onError` toasts the message
//   - `onSettled` invalidates the PR review queries that the
//     mutation could have invalidated (overview `getPullRequest` for
//     `submitReview` because reviewDecision may flip; `listReviewThreads`
//     for both because a new thread lands immediately)
//   - the sheet / composer ALSO renders inline errors because toasts
//     paint behind formSheets on iOS
//
// `createReviewComment` posts ONE comment immediately (no pending
// review). `submitReview` posts a BATCH — the composer enqueues
// comments into the `PendingReviewProvider` and the submit sheet
// drains that queue into one `submitReview` call. The submission
// uses the LATEST head SHA (per the S3 contract) regardless of what
// SHA each item was queued under; a per-item 422 surfaces inline.
//
// P1-A-08c: both hooks hoist one operation key per intent, so retries of the
// same intent dedupe on the server instead of re-executing the write. The
// ledger markers map onto the existing per-surface copy.

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';

import { i18n } from '@/i18n';
import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { useHoistedOperationKey } from '@/lib/operation-key';
import {
  isPrMutationRetryable,
  mapPrOperationError,
  prOperationToastMessage,
} from '@/lib/pr-review/merge/pr-operation-ledger';

type PrRef = { owner: string; repo: string; number: number };

function usePrRefKeys(ref: PrRef) {
  const trpc = useTRPC();
  return {
    getPullRequest: trpc.githubPrReview.getPullRequest.queryKey(ref),
    listReviewThreadsPath: trpc.githubPrReview.listReviewThreads.pathFilter(),
  };
}

async function invalidateReviewCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: ReturnType<typeof usePrRefKeys>
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.getPullRequest }),
    queryClient.invalidateQueries(keys.listReviewThreadsPath),
  ]);
}

export type CreateReviewCommentInput = {
  owner: string;
  repo: string;
  number: number;
  body: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
  commitSha: string;
};

export function useCreateReviewCommentMutation(ref: PrRef) {
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: CreateReviewCommentInput) => {
      try {
        const result = await trpcClient.githubPrReview.createReviewComment.mutate({
          ...input,
          operationKey: getKey(prIntentFingerprint('create_review_comment', input)),
        });
        rotateKey();
        return result;
      } catch (error) {
        if (!isPrMutationRetryable(error)) {
          rotateKey();
        }
        throw mapPrOperationError(error, 'create-comment');
      }
    },
    onSuccess: () => {
      // Bare success announcement beside the composer's existing success
      // effect (haptic + dismiss). The inline composer error box owns the
      // persistent inline error; the toast owns the failure announcement.
      announceForA11y(i18n.t('prReview.announce.commentPosted'));
    },
    onError: (error: { message: string }) => {
      announcingToast.error(prOperationToastMessage(error, 'create-comment'));
    },
    onSettled: async () => {
      await invalidateReviewCaches(queryClient, keys);
    },
  });
}

export type SubmitReviewComment = {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  startLine?: number;
  startSide?: 'LEFT' | 'RIGHT';
  body: string;
};

export type SubmitReviewInput = {
  owner: string;
  repo: string;
  number: number;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body?: string;
  commitSha: string;
  comments?: SubmitReviewComment[];
};

export function useSubmitReviewMutation(ref: PrRef) {
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: SubmitReviewInput) => {
      try {
        const result = await trpcClient.githubPrReview.submitReview.mutate({
          ...input,
          operationKey: getKey(prIntentFingerprint('submit_review', input)),
        });
        rotateKey();
        return result;
      } catch (error) {
        if (!isPrMutationRetryable(error)) {
          rotateKey();
        }
        throw mapPrOperationError(error, 'submit-review');
      }
    },
    onSuccess: () => {
      // Bare success announcement beside the submit sheet's existing
      // success effect (queue clear + haptic + dismiss).
      announceForA11y(i18n.t('prReview.announce.reviewSubmitted'));
    },
    onError: (error: { message: string }) => {
      announcingToast.error(prOperationToastMessage(error, 'submit-review'));
    },
    onSettled: async () => {
      await invalidateReviewCaches(queryClient, keys);
    },
  });
}
