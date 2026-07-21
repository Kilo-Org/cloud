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

import { useTRPC } from '@/lib/trpc';

type PrRef = { owner: string; repo: string; number: number };

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
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const keys = usePrRefKeys(ref);

  return useMutation(
    trpc.githubPrReview.mergePullRequest.mutationOptions({
      onError: (error: { message: string }) => {
        toast.error(error.message);
      },
      onSettled: async () => {
        await invalidatePrCaches(queryClient, keys);
      },
    })
  );
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
