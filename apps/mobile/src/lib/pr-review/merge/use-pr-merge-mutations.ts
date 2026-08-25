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

import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { trpcClient, useTRPC } from '@/lib/trpc';
import {
  assertMergeResult,
  gateMergeResult,
  type MergePullRequestResult,
} from '@/lib/pr-review/merge/merge-result-gate';
import { useHoistedOperationKey } from '@/lib/operation-key';
import {
  isPrMutationRetryable,
  mapPrOperationError,
  prOperationToastMessage,
} from '@/lib/pr-review/merge/pr-operation-ledger';

type PrRef = { owner: string; repo: string; number: number };

type RouterInputs = inferRouterInputs<MobileRouter>;
type MergePullRequestInput = RouterInputs['githubPrReview']['mergePullRequest'];

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
  // P1-A-08c: the hoisted operation key rides the input so a same-key retry
  // reconciles against authoritative PR state before ever re-merging.
  return useMutation<MergePullRequestResult, Error, MergePullRequestInput>({
    mutationFn: async input => {
      try {
        const result = await trpcClient.githubPrReview.mergePullRequest.mutate({
          ...input,
          operationKey: getKey(prIntentFingerprint('merge', input)),
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
    onSuccess: (result: MergePullRequestResult) => {
      // One announcement owner per outcome. `assertMergeResult` gated
      // `merged: true` before this runs, so only clean and partial
      // outcomes reach here. The partial announcement carries the full
      // merged-but-branch-delete-failed message; the persistent banner
      // (which renders that text) has no live region of its own.
      const gate = gateMergeResult(result);
      const message =
        gate.kind === 'partial' ? `Merged. Couldn't delete the branch: ${gate.reason}` : 'Merged';
      announceForA11y(message);
    },
    onError: (error: { message: string }) => {
      announcingToast.error(prOperationToastMessage(error, 'merge'));
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
        announcingToast.error(error.message);
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
      onSuccess: () => {
        // Bare success announcement beside the merge sheet's existing
        // auto-merge success effect (haptic + refetch + dismiss).
        announceForA11y('Auto-merge enabled');
      },
      onError: (error: { message: string }) => {
        announcingToast.error(error.message);
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
        announcingToast.error(error.message);
      },
      onSettled: async () => {
        await invalidatePrCaches(queryClient, keys);
      },
    })
  );
}
