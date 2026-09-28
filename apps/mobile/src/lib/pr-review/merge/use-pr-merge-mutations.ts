// S8 merge-side mutation hooks, s6: provider-aware through the
// `providerReview` seam. Pattern mirrors the repo's existing
// mutation hooks (useSessionMutations, useSecurityAgentMutations):
//  - `onError` toasts the message
//  - `onSettled` invalidates the overview + the per-PR listChecks /
//    listFiles caches so the new head SHA refetches
//  - keeps the mutation hook thin and lets the sheet / section handle
//    inline errors (toasts paint behind formSheets)
//
// listChecks is keyed by `(owner, repo, ref)` on GitHub. The head ref will
// change after a successful merge / update-branch, so we invalidate the
// procedure PATH (not a single key) — every cached check list for this
// PR is dropped and any mounted consumer re-fetches against the new
// head. `listFiles` is per-page; we invalidate the full procedure too.
// The provider arms mirror this on `providerReview` (path filters).
//
// Provider arms (s6): `mergePullRequest` requires the `expectedHeadSha`
// fence on every provider — the server refuses a moved head with the
// explicit stale-head reason (CONFLICT) before any merge call, and the
// sheet keeps that reason inline without navigating away. The provider
// result `{done, replayed}` is normalized onto the GitHub result shape so
// the existing `assertMergeResult` gate keeps its "never celebrate a
// merge that did not happen" contract. Auto-merge is GitLab-only:
// Bitbucket Cloud has no auto-merge API, and the server answers
// `enableAutoMerge` with `{supported: false, reason}` so the UI shows the
// provider reason instead of failing.

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import { providerPrTerm } from '@kilocode/app-shared/provider-review';
import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { i18n } from '@/i18n';
import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { type ProviderPrScope, providerPrTriple } from '@/lib/pr-review/provider-pr-ref';
import {
  providerFingerprintInput,
  providerWriteIdentity,
  type ReviewWriteRef,
  useReviewWriteScope,
} from '@/lib/pr-review/use-pr-review-mutations';
import {
  assertMergeResult,
  gateMergeResult,
  type MergePullRequestResult,
} from '@/lib/pr-review/merge/merge-result-gate';
import { MergeNotCompletedError } from '@/lib/pr-review/merge/merge-result-error';
import { useHoistedOperationKey } from '@/lib/operation-key';
import {
  isPrMutationRetryable,
  mapPrOperationError,
  prOperationToastMessage,
} from '@/lib/pr-review/merge/pr-operation-ledger';

type PrRef = { owner: string; repo: string; number: number };

type RouterInputs = inferRouterInputs<MobileRouter>;
type MergePullRequestInput = RouterInputs['githubPrReview']['mergePullRequest'];
type GithubAutoMergeInput = RouterInputs['githubPrReview']['enableAutoMerge'];
type GithubDisableAutoMergeInput = RouterInputs['githubPrReview']['disableAutoMerge'];

/**
 * The merge-sheet vars for a provider PR/MR. `method` is a UI concept:
 * GitLab folds it into `squash`, Bitbucket Cloud has only the merge
 * commit, and the fingerprint mirrors the server's `method` field.
 */
export type ProviderMergeVars = {
  expectedHeadSha: string;
  squash?: boolean;
  deleteBranch?: boolean;
  commitTitle?: string;
  commitMessage?: string;
};
export type MergeVars = MergePullRequestInput | ProviderMergeVars;

/** The auto-merge vars for a provider MR (GitLab; Bitbucket answers unsupported). */
type ProviderAutoMergeVars = { expectedHeadSha: string };
export type EnableAutoMergeVars = GithubAutoMergeInput | ProviderAutoMergeVars;
export type DisableAutoMergeVars = GithubDisableAutoMergeInput | ProviderAutoMergeVars;

/**
 * The resolved auto-merge answer across arms: GitHub reports
 * `{enabled, prNodeId}`, the provider seam reports `{supported, reason}`
 * plus the ledger flags. Every field is optional so both arms land in the
 * same `TData`; only `supported: false` (Bitbucket has no auto-merge API)
 * is read back, to keep the success announcement off an unsupported answer.
 */
export type AutoMergeOutcome = {
  enabled?: boolean;
  prNodeId?: string;
  supported?: boolean;
  reason?: string;
  done?: boolean;
  replayed?: boolean;
};

function useMergeKeys(scope: ProviderPrScope) {
  const trpc = useTRPC();
  if (scope.ref.platform === 'github') {
    const triple = providerPrTriple(scope.ref);
    return {
      getPullRequest: trpc.githubPrReview.getPullRequest.queryKey(triple),
      listChecksPath: trpc.githubPrReview.listChecks.pathFilter(),
      listFilesPath: trpc.githubPrReview.listFiles.pathFilter(),
    };
  }
  return {
    getPullRequest: trpc.providerReview.getPullRequest.queryKey(providerWriteIdentity(scope)),
    listChecksPath: trpc.providerReview.listChecks.pathFilter(),
    listFilesPath: trpc.providerReview.listFiles.pathFilter(),
  };
}

async function invalidatePrCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: ReturnType<typeof useMergeKeys>
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.getPullRequest }),
    queryClient.invalidateQueries(keys.listChecksPath),
    queryClient.invalidateQueries(keys.listFilesPath),
  ]);
}

/** The hoisted operation-key getter a mutation arm stamps its fingerprint with. */
type OperationKeyGetter = (fingerprint: string) => string;

/** The GitHub merge arm — the pre-s6 call, unchanged. */
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function githubMergeResult(
  vars: MergePullRequestInput,
  getKey: OperationKeyGetter
): Promise<MergePullRequestResult> {
  return trpcClient.githubPrReview.mergePullRequest.mutate({
    ...vars,
    operationKey: getKey(prIntentFingerprint('merge', vars)),
  });
}

/**
 * The provider merge arm. One call per platform arm: a conditional spread
 * inside a single literal would cross-multiply the identity union and hand
 * the server gitlab-only fields on a bitbucket call. The layer reports no
 * separate branch-delete outcome: the source-branch removal rides the merge
 * call itself, so a committed merge is always the clean shape for the gate.
 * A `done: false` answer is the same never-celebrate contract as GitHub's
 * `merged: false`, but with provider wording: the default
 * `MergeNotCompletedError` message names GitHub.
 */
async function providerMergeResult(
  scope: ProviderPrScope,
  vars: ProviderMergeVars,
  getKey: OperationKeyGetter
): Promise<MergePullRequestResult> {
  const identity = providerWriteIdentity(scope);
  const merged =
    identity.platform === 'gitlab'
      ? await trpcClient.providerReview.mergePullRequest.mutate({
          ...identity,
          expectedHeadSha: vars.expectedHeadSha,
          ...(vars.squash !== undefined ? { squash: vars.squash } : {}),
          ...(vars.deleteBranch !== undefined ? { deleteBranch: vars.deleteBranch } : {}),
          ...(vars.commitTitle !== undefined ? { commitTitle: vars.commitTitle } : {}),
          ...(vars.commitMessage !== undefined ? { commitMessage: vars.commitMessage } : {}),
          operationKey: getKey(
            prIntentFingerprint(
              'merge',
              providerFingerprintInput(identity, {
                method: vars.squash ? 'squash' : 'merge',
                commitTitle: vars.commitTitle,
                commitMessage: vars.commitMessage,
                deleteBranch: vars.deleteBranch,
                expectedHeadSha: vars.expectedHeadSha,
              })
            )
          ),
        })
      : await trpcClient.providerReview.mergePullRequest.mutate({
          ...identity,
          expectedHeadSha: vars.expectedHeadSha,
          ...(vars.deleteBranch !== undefined ? { deleteBranch: vars.deleteBranch } : {}),
          ...(vars.commitMessage !== undefined ? { commitMessage: vars.commitMessage } : {}),
          operationKey: getKey(
            prIntentFingerprint(
              'merge',
              providerFingerprintInput(identity, {
                method: 'merge',
                commitMessage: vars.commitMessage,
                deleteBranch: vars.deleteBranch,
                expectedHeadSha: vars.expectedHeadSha,
              })
            )
          ),
        });
  if (!merged.done) {
    throw new MergeNotCompletedError({
      sha: vars.expectedHeadSha,
      message: i18n.t('prReview.operation.mergeResultNotCompleted', {
        term: providerPrTerm(scope.ref.platform),
      }),
    });
  }
  return { merged: true, sha: vars.expectedHeadSha, branchDeleted: false };
}

export function useMergePullRequestMutation(ref: ReviewWriteRef) {
  const queryClient = useQueryClient();
  const scope = useReviewWriteScope(ref);
  const keys = useMergeKeys(scope);
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
  return useMutation<MergePullRequestResult, Error, MergeVars>({
    mutationFn: async input => {
      try {
        const result =
          scope.ref.platform === 'github'
            ? await githubMergeResult(input as MergePullRequestInput, getKey)
            : await providerMergeResult(scope, input as ProviderMergeVars, getKey);
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
        gate.kind === 'partial'
          ? i18n.t('prReview.merge.partialSuccessBanner.accessibility', { reason: gate.reason })
          : i18n.t('prReview.overview.stateMerged');
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
  const keys = useMergeKeys({ ref: { platform: 'github', ...ref }, organizationId: null });

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

/**
 * Arm auto-merge. GitHub keeps its exact pre-s6 path; GitLab arms
 * merge-when-pipeline-succeeds fenced on the head; Bitbucket Cloud has no
 * auto-merge API, so the server answers `{supported: false, reason}` —
 * the sheet shows the reason instead of celebrating.
 */
export function useEnableAutoMergeMutation(ref: ReviewWriteRef) {
  const queryClient = useQueryClient();
  const scope = useReviewWriteScope(ref);
  const keys = useMergeKeys(scope);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation<AutoMergeOutcome, Error, EnableAutoMergeVars>({
    mutationFn: async (vars: EnableAutoMergeVars) => {
      if (scope.ref.platform === 'github') {
        return trpcClient.githubPrReview.enableAutoMerge.mutate(vars as GithubAutoMergeInput);
      }
      try {
        const result = await trpcClient.providerReview.enableAutoMerge.mutate({
          ...providerWriteIdentity(scope),
          expectedHeadSha: (vars as ProviderAutoMergeVars).expectedHeadSha,
          operationKey: getKey(
            prIntentFingerprint(
              'enable_auto_merge',
              providerFingerprintInput(scope.ref, {
                expectedHeadSha: (vars as ProviderAutoMergeVars).expectedHeadSha,
              })
            )
          ),
        });
        rotateKey();
        return result;
      } catch (error) {
        if (!isPrMutationRetryable(error)) {
          rotateKey();
        }
        throw mapPrOperationError(error, 'merge');
      }
    },
    onSuccess: (result: AutoMergeOutcome) => {
      // Bare success announcement beside the merge sheet's existing
      // auto-merge success effect (haptic + refetch + dismiss). A
      // `supported: false` answer (Bitbucket) is not a success — the
      // sheet renders the provider reason instead.
      if (result.supported !== false) {
        announceForA11y(i18n.t('prReview.announce.autoMergeEnabled'));
      }
    },
    onError: (error: { message: string }) => {
      announcingToast.error(error.message);
    },
    onSettled: async () => {
      await invalidatePrCaches(queryClient, keys);
    },
  });
}

/** Cancel auto-merge. Same arms as `useEnableAutoMergeMutation`. */
export function useDisableAutoMergeMutation(ref: ReviewWriteRef) {
  const queryClient = useQueryClient();
  const scope = useReviewWriteScope(ref);
  const keys = useMergeKeys(scope);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (vars: DisableAutoMergeVars) => {
      if (scope.ref.platform === 'github') {
        return trpcClient.githubPrReview.disableAutoMerge.mutate(
          vars as GithubDisableAutoMergeInput
        );
      }
      try {
        const result = await trpcClient.providerReview.disableAutoMerge.mutate({
          ...providerWriteIdentity(scope),
          expectedHeadSha: (vars as ProviderAutoMergeVars).expectedHeadSha,
          operationKey: getKey(
            prIntentFingerprint(
              'disable_auto_merge',
              providerFingerprintInput(scope.ref, {
                expectedHeadSha: (vars as ProviderAutoMergeVars).expectedHeadSha,
              })
            )
          ),
        });
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
      announcingToast.error(error.message);
    },
    onSettled: async () => {
      await invalidatePrCaches(queryClient, keys);
    },
  });
}
