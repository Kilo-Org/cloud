// S8 merge-side mutation hooks. Pattern mirrors the repo's existing
// mutation hooks (useSessionMutations, useSecurityAgentMutations):
//  - `onError` toasts the message
//  - `onSettled` invalidates the overview + the per-PR listChecks /
//    listFiles caches so the new head SHA refetches
//  - keeps the mutation hook thin and lets the sheet / section handle
//    inline errors (toasts paint behind formSheets)
//
// listChecks is keyed by `(owner, repo, ref)`. The head ref will change
// after a successful merge / update-branch, so we invalidate the
// procedure PATH (not a single key) — every cached check list for this
// PR is dropped and any mounted consumer re-fetches against the new
// head. `listFiles` is per-page; we invalidate the full procedure too.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { trpcClient, useTRPC } from '@/lib/trpc';
import {
  assertMergeResult,
  type MergePullRequestResult,
} from '@/lib/pr-review/merge/merge-result-gate';
import {
  isPrMutationRetryable,
  mapPrOperationError,
  prOperationToastMessage,
  useHoistedOperationKey,
} from '@/lib/pr-review/merge/pr-operation-ledger';

type PrRef = { owner: string; repo: string; number: number };

type MergePullRequestInput = {
  owner: string;
  repo: string;
  number: number;
  method: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
  commitMessage?: string;
  deleteBranch: boolean;
  expectedHeadSha: string;
};

/**
 * Deterministic intent fingerprint for a merge submit. Every intent-defining
 * input is included: merge method, commit title/message, delete-branch flag,
 * the expected-head fence, and the resource. A retry of the SAME merge reuses
 * the hoisted operation key; changing the method or message (or another input)
 * rotates the key so a changed intent cannot replay the previous merge's
 * canonical ledger result.
 */
export function mergePullRequestIntentFingerprint(input: MergePullRequestInput): string {
  return JSON.stringify({
    resource: [input.owner, input.repo, input.number],
    method: input.method,
    commitTitle: input.commitTitle,
    commitMessage: input.commitMessage,
    deleteBranch: input.deleteBranch,
    expectedHeadSha: input.expectedHeadSha,
  });
}

function usePrRefKeys(ref: PrRef) {
  const trpc = useTRPC();
  return {
    getPullRequest: trpc.githubPrReview.getPullRequest.queryKey(ref),
    listChecksPath: trpc.githubPrReview.listChecks.pathFilter(),
    listFilesPath: trpc.githubPrReview.listFiles.pathFilter(),
  };
}

async function invalidatePrCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: ReturnType<typeof usePrRefKeys>
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.getPullRequest }),
    queryClient.invalidateQueries(keys.listChecksPath),
    queryClient.invalidateQueries(keys.listFilesPath),
  ]);
}

export function useMergePullRequestMutation(ref: PrRef) {
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);
  const { getKey, rotateKey } = useHoistedOperationKey();

  // P0-B-08: gate success on the authoritative `merged: true` result
  // BEFORE React Query resolves the mutation. The server only treats
  // `merged: true` as a real merge — a `merged: false` reply (e.g. a 405
  // "not mergeable" where GitHub refuses) must NOT be celebrated as a
  // success. `assertMergeResult` throws `MergeNotCompletedError` on
  // `merged !== true`; that throw lands in `onError` and the sheet's
  // existing classification effect treats it as RETRYABLE (NOT terminal
  // bad-request), so the submit button stays enabled and the user can
  // retry. The typed return is preserved so `performSubmit` can read
  // the sha / branchDeleted / branchDeleteError off the resolved value.
  //
  // P1-A-08c: the hoisted operation key is merged into the input so a
  // same-key retry reconciles against authoritative PR state before
  // ever re-merging; it is regenerated after a real merge or a
  // non-retryable failure. The two ledger outcome markers are mapped
  // onto the existing per-surface copy for the toast.
  return useMutation<MergePullRequestResult, Error, MergePullRequestInput>({
    mutationFn: async input => {
      try {
        const result = await trpcClient.githubPrReview.mergePullRequest.mutate({
          ...input,
          operationKey: getKey(mergePullRequestIntentFingerprint(input)),
        });
        // Throws on `merged: false`; returns the gate on clean / partial.
        assertMergeResult(result);
        rotateKey();
        return result;
      } catch (error) {
        if (!isPrMutationRetryable(error)) {
          rotateKey();
        }
        throw mapPrOperationError(error, 'merge');
      }
    },
    onError: (error: { message: string }) => {
      toast.error(prOperationToastMessage(error, 'merge'));
    },
    onSettled: async () => {
      await invalidatePrCaches(queryClient, keys);
    },
  });
}

export function useUpdateBranchMutation(ref: PrRef) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);

  return useMutation(
    trpc.githubPrReview.updateBranch.mutationOptions({
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidatePrCaches(queryClient, keys);
      },
    })
  );
}

export function useEnableAutoMergeMutation(ref: PrRef) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);

  return useMutation(
    trpc.githubPrReview.enableAutoMerge.mutationOptions({
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidatePrCaches(queryClient, keys);
      },
    })
  );
}

export function useDisableAutoMergeMutation(ref: PrRef) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);

  return useMutation(
    trpc.githubPrReview.disableAutoMerge.mutationOptions({
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidatePrCaches(queryClient, keys);
      },
    })
  );
}
