// S7a mutation hooks for inline PR review comments and the pending-
// review batch submit, s6: provider-aware through the `providerReview` seam.
// The pattern mirrors the existing S8 merge mutations:
//   - `onError` toasts the message
//   - `onSettled` invalidates the PR review queries that the
//     mutation could have invalidated (overview `getPullRequest` for
//     `submitReview` because reviewDecision may flip; the thread list
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
// Provider arms (s6): a GitLab MR or Bitbucket PR posts through
// `providerReview.addComment` / `providerReview.submitReview`. Those
// procedures carry NO inline position and NO comment batch — the
// provider APIs have none — so the composer anchors the position in
// the body text and the submit sheet folds the queued comments into
// the review summary (see `formatPendingCommentBody`). The GitHub arms
// stay byte-identical: same procedures, same inputs, same fingerprints.
//
// P1-A-08c: both hooks hoist one operation key per intent, so retries of the
// same intent dedupe on the server instead of re-executing the write. The
// ledger markers map onto the existing per-surface copy. The provider key
// fingerprint folds the s1 provider identity (platform + instance hint /
// workspace), so a GitLab comment and a same-named GitHub comment can never
// share a ledger key — the same bytes the server hashes into `resource_key`.

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { prIntentFingerprint } from '@kilocode/app-shared/pr-review';
import {
  type BitbucketPrRef,
  type GitLabMrRef,
  type ProviderPrRef,
} from '@kilocode/app-shared/provider-review';
import { type inferRouterInputs, type MobileRouter } from '@kilocode/trpc/mobile';

import { i18n } from '@/i18n';
import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { trpcClient, useTRPC } from '@/lib/trpc';
import { useHoistedOperationKey } from '@/lib/operation-key';
import {
  type ProviderPrScope,
  providerPrTriple,
  type ProviderPrTriple,
  useProviderPrScope,
} from '@/lib/pr-review/provider-pr-ref';
import {
  isPrMutationRetryable,
  mapPrOperationError,
  prOperationToastMessage,
} from '@/lib/pr-review/merge/pr-operation-ledger';

type PrRef = { owner: string; repo: string; number: number };

/** Any ref the review write hooks accept: the legacy triple or a provider ref. */
export type ReviewWriteRef = ProviderPrRef | PrRef;

/** The legacy triple behind any accepted ref. */
function reviewWriteTriple(ref: ReviewWriteRef): ProviderPrTriple {
  return 'platform' in ref ? providerPrTriple(ref) : ref;
}

/**
 * The provider write identity every `providerReview` mutation input carries.
 * Mirrors `providerIdentity()` in `provider-pr-queries.ts` exactly, so the
 * invalidation keys below hit the same cache entries the reads populate.
 */
export type ProviderWriteIdentity =
  | {
      platform: 'gitlab';
      projectPath: string;
      mrIid: number;
      instanceHint?: string;
      organizationId?: string;
    }
  | {
      platform: 'bitbucket';
      workspace: string;
      repoSlug: string;
      prId: number;
      organizationId: string;
    };

/** The mutation-side identity of one scope — the read-side twin, unchanged. */
export function providerWriteIdentity(scope: ProviderPrScope): ProviderWriteIdentity {
  const { ref, organizationId } = scope;
  if (ref.platform === 'gitlab') {
    return {
      platform: 'gitlab',
      projectPath: ref.projectPath,
      mrIid: ref.mrIid,
      ...(ref.instanceHint ? { instanceHint: ref.instanceHint } : {}),
      ...(organizationId ? { organizationId } : {}),
    };
  }
  return {
    platform: 'bitbucket',
    workspace: ref.platform === 'bitbucket' ? ref.workspace : '',
    repoSlug: ref.platform === 'bitbucket' ? ref.repoSlug : '',
    prId: ref.platform === 'bitbucket' ? ref.prId : 0,
    organizationId: organizationId ?? '',
  };
}

/**
 * The fingerprint input the server hashes into `resource_key`: the s1
 * provider identity fields (`gitlabFingerprintInput` /
 * `bitbucketFingerprintInput` in provider-review-router.ts) plus the
 * intent-defining fields. Field VALUES must match the server's — the
 * fingerprint is the dedupe identity, and a drift makes every same-key
 * retry fail with `operation_key_reuse_mismatch`.
 */
export function providerFingerprintInput(
  ref: GitLabMrRef | BitbucketPrRef,
  fields: Record<string, unknown>
) {
  if (ref.platform === 'gitlab') {
    return {
      platform: 'gitlab',
      projectPath: ref.projectPath,
      instanceHint: ref.instanceHint,
      number: ref.mrIid,
      ...fields,
    };
  }
  return {
    platform: 'bitbucket',
    workspace: ref.workspace,
    repoSlug: ref.repoSlug,
    number: ref.prId,
    ...fields,
  };
}

/**
 * The write scope: the caller's ref paired with the organization the live
 * provider scope publishes. On the GitHub route the context is absent and
 * the organization is null — exactly what the GitHub arms already sent.
 */
export function useReviewWriteScope(ref: ReviewWriteRef): ProviderPrScope {
  const scope = useProviderPrScope(reviewWriteTriple(ref));
  return 'platform' in ref ? { ref, organizationId: scope.organizationId } : scope;
}

function usePrRefKeys(scope: ProviderPrScope) {
  const trpc = useTRPC();
  if (scope.ref.platform === 'github') {
    const triple = providerPrTriple(scope.ref);
    return {
      getPullRequest: trpc.githubPrReview.getPullRequest.queryKey(triple),
      threadsPath: trpc.githubPrReview.listReviewThreads.pathFilter(),
    };
  }
  return {
    getPullRequest: trpc.providerReview.getPullRequest.queryKey(providerWriteIdentity(scope)),
    threadsPath: trpc.providerReview.listDiscussions.pathFilter(),
  };
}

async function invalidateReviewCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  keys: ReturnType<typeof usePrRefKeys>
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.getPullRequest }),
    queryClient.invalidateQueries(keys.threadsPath),
  ]);
}

type RouterInputs = inferRouterInputs<MobileRouter>;

type CreateReviewCommentInput = RouterInputs['githubPrReview']['createReviewComment'];
export type SubmitReviewInput = RouterInputs['githubPrReview']['submitReview'];
export type SubmitReviewComment = NonNullable<SubmitReviewInput['comments']>[number];

/** The provider arms accept a body only — no inline position, no batch. */
type ProviderCommentBody = { body: string };
export type CreateReviewCommentVars = CreateReviewCommentInput | ProviderCommentBody;

/**
 * The body a provider comment carries: GitLab and Bitbucket have no inline
 * comment position, so the composer (direct post) and the submit sheet
 * (pending comments folded into the review summary) anchor the location in
 * the text itself, in the same `path:L10–L20` format the pending list shows.
 */
export function formatPendingCommentBody(item: {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}): string {
  const location =
    item.startLine !== undefined && item.startLine !== item.line
      ? `${item.path}:L${item.startLine}–L${item.line}`
      : `${item.path}:L${item.line}`;
  return `${location}\n\n${item.body}`;
}

/**
 * The body a provider `submitReview` carries: the summary, then every fresh
 * pending comment anchored in the text (the provider event has no comment
 * batch). Empty parts are dropped, so an approve with a summary alone posts
 * exactly the summary and an approve with neither posts nothing.
 */
export function buildProviderSubmitBody(
  summary: string,
  items: readonly {
    path: string;
    line: number;
    startLine?: number;
    body: string;
  }[]
): string {
  return [summary.trim(), ...items.map(item => formatPendingCommentBody(item))]
    .filter(part => part.length > 0)
    .join('\n\n');
}

/** The events the `providerReview.submitReview` input accepts. */
export type ProviderReviewEventOption = 'approve' | 'request_changes' | 'comment';
type ProviderSubmitReviewVars = {
  event: ProviderReviewEventOption;
  body?: string;
};
export type SubmitReviewVars = SubmitReviewInput | ProviderSubmitReviewVars;

export function useCreateReviewCommentMutation(ref: ReviewWriteRef) {
  const queryClient = useQueryClient();
  const scope = useReviewWriteScope(ref);
  const keys = usePrRefKeys(scope);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: CreateReviewCommentVars) => {
      try {
        if (scope.ref.platform === 'github') {
          const vars = input as CreateReviewCommentInput;
          const result = await trpcClient.githubPrReview.createReviewComment.mutate({
            ...vars,
            operationKey: getKey(prIntentFingerprint('create_review_comment', vars)),
          });
          rotateKey();
          return result;
        }
        const vars = input as ProviderCommentBody;
        const result = await trpcClient.providerReview.addComment.mutate({
          ...providerWriteIdentity(scope),
          body: vars.body,
          operationKey: getKey(
            prIntentFingerprint(
              'create_review_comment',
              providerFingerprintInput(scope.ref, { body: vars.body })
            )
          ),
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

export function useSubmitReviewMutation(ref: ReviewWriteRef) {
  const queryClient = useQueryClient();
  const scope = useReviewWriteScope(ref);
  const keys = usePrRefKeys(scope);
  const { getKey, rotateKey } = useHoistedOperationKey();

  return useMutation({
    mutationFn: async (input: SubmitReviewVars) => {
      try {
        if (scope.ref.platform === 'github') {
          const vars = input as SubmitReviewInput;
          const result = await trpcClient.githubPrReview.submitReview.mutate({
            ...vars,
            operationKey: getKey(prIntentFingerprint('submit_review', vars)),
          });
          rotateKey();
          return result;
        }
        const vars = input as ProviderSubmitReviewVars;
        const result = await trpcClient.providerReview.submitReview.mutate({
          ...providerWriteIdentity(scope),
          event: vars.event,
          ...(vars.body !== undefined && vars.body.length > 0 ? { body: vars.body } : {}),
          operationKey: getKey(
            prIntentFingerprint(
              'submit_review',
              providerFingerprintInput(scope.ref, { event: vars.event, body: vars.body })
            )
          ),
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
