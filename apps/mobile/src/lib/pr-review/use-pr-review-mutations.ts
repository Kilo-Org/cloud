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
// P1-A-08c: both hooks hoist one operation key per intent. The key is
// merged into the mutation input, so retries of the same intent dedupe /
// replay / reconcile on the server instead of re-executing the write. The
// key is regenerated after a success or a non-retryable failure (fresh
// intent) and kept across retryable failures (the ledger owns the retry).
// The two ledger outcome markers are mapped onto the existing per-surface
// copy so the inline error boxes and toasts keep their established wording.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { trpcClient, useTRPC } from '@/lib/trpc';
import {
  isPrMutationRetryable,
  mapPrOperationError,
  prOperationToastMessage,
  useHoistedOperationKey,
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

/**
 * Deterministic intent fingerprint for a create-comment submit. Every
 * intent-defining input is included: the retry of the SAME input reuses the
 * hoisted operation key, and ANY change (body, path, line, side, commit sha,
 * resource) rotates the key so the ledger treats it as a fresh intent.
 */
export function createReviewCommentIntentFingerprint(input: CreateReviewCommentInput): string {
  return JSON.stringify({
    resource: [input.owner, input.repo, input.number],
    body: input.body,
    path: input.path,
    line: input.line,
    side: input.side,
    startLine: input.startLine,
    startSide: input.startSide,
    commitSha: input.commitSha,
  });
}

export function useCreateReviewCommentMutation(ref: PrRef) {
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: CreateReviewCommentInput) => {
      try {
        const result = await trpcClient.githubPrReview.createReviewComment.mutate({
          ...input,
          operationKey: getKey(createReviewCommentIntentFingerprint(input)),
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
    onError: (error: { message: string }) => {
      toast.error(prOperationToastMessage(error, 'create-comment'));
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

/**
 * Deterministic intent fingerprint for a submit-review. Every intent-defining
 * input is included: event, summary body, commit sha, and the full inline
 * comment batch (path/line/side/body). A retry of the SAME review reuses the
 * hoisted key; changing the event, the summary, or any queued comment rotates
 * it so the ledger cannot replay the previous review's canonical result.
 */
export function submitReviewIntentFingerprint(input: SubmitReviewInput): string {
  return JSON.stringify({
    resource: [input.owner, input.repo, input.number],
    event: input.event,
    body: input.body,
    commitSha: input.commitSha,
    comments: input.comments,
  });
}

export function useSubmitReviewMutation(ref: PrRef) {
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: SubmitReviewInput) => {
      try {
        const result = await trpcClient.githubPrReview.submitReview.mutate({
          ...input,
          operationKey: getKey(submitReviewIntentFingerprint(input)),
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
    onError: (error: { message: string }) => {
      toast.error(prOperationToastMessage(error, 'submit-review'));
    },
    onSettled: async () => {
      await invalidateReviewCaches(queryClient, keys);
    },
  });
}
