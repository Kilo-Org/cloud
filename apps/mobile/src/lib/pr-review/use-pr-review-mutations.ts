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

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

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

export function useCreateReviewCommentMutation(ref: PrRef) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);

  return useMutation(
    trpc.githubPrReview.createReviewComment.mutationOptions({
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateReviewCaches(queryClient, keys);
      },
    })
  );
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
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);

  return useMutation(
    trpc.githubPrReview.submitReview.mutationOptions({
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidateReviewCaches(queryClient, keys);
      },
    })
  );
}
